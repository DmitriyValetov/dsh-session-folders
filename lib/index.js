// dsh-session-folders host half: a Cordis plug-in that persists feature
// folders (one level of named folders per workspace) in its own storage
// domain and serves the folder CRUD/move/reorder/pin and unarchive API to the web client over
// the dsh webServer. The workspace registry owns the durable workspace/session
// accounting; we hold only folder records and read the registry for every
// validation (workspace existence, session membership).
//
// Wire contract: requests and responses are JSON. Success payloads are
// route-specific ({ folders }, { id }, { ok: true }); failures always have
// the shape { error: <code> } with a non-2xx status. Routes are same-origin
// and unauthenticated (dsh-session-manager precedent), so every input is
// validated server-side.

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { hasNameConflict, isExactIdSet, parseFolderName } from "./folder-utils.js";

// Ported to DSH 0.2.0-rc.1: a profile plugin resolves modules from the profile's own
// node_modules, so harness packages (@deepseek-ai/dsh-storage-domain / -dsh-llm) are not
// importable here. The domain declaration helper and its checks are inlined below, and the
// auto-rename model call (which needed -dsh-llm) is removed together with its client entry.
/**
* Validate one storage-domain declaration.
* @param spec - the declaration handed to ctx.storageDomain.open.
* @returns the same declaration.
*/
function defineDomain(spec) {
	if (!/^[a-z][a-z0-9_]*$/.test(spec.name)) throw new Error(`domain name '${spec.name}' is invalid`);
	if (!Number.isInteger(spec.version) || spec.version < 0) throw new Error(`domain '${spec.name}' version must be a non-negative integer`);
	for (const compat of spec.compatibleVersions ?? []) if (!Number.isInteger(compat) || compat < 0 || compat >= spec.version) throw new Error(`domain '${spec.name}' compatibleVersions entries must be non-negative integers below version ${spec.version}`);
	if (spec.layout !== void 0 && spec.layout !== "single" && spec.layout !== "per-record") throw new Error(`domain '${spec.name}' layout must be 'single' or 'per-record'`);
	for (const table of Object.keys(spec.tables)) if (!/^[a-z][a-z0-9_]*$/.test(table)) throw new Error(`domain '${spec.name}' table name '${table}' is invalid`);
	if (spec.global !== void 0 && spec.global.schema.safeParse(null).success) throw new Error(`domain '${spec.name}' global schema must not accept null`);
	return spec;
}

/** Plug-in identity used by the cordis loader. */
const name = "dsh-session-folders";
/**
* Host services this plug-in consumes. Note: 'logger' is NOT a service —
* ctx.logger is a built-in Context property and must never be injected;
* only these three real services are needed.
*/
const inject = ["webServer", "storageDomain", "workspaceRegistry"];



/** Route prefix; all routes live under it (duplicate (kind, path) registrations throw). */
const ROUTE_PREFIX = "/dsh-session-folders";
/** Cap on request body size, mirroring the dsh-session-manager wire discipline. */
const MAX_BODY_BYTES = 65536;
/** Session ids arrive as bare UUIDs or with the 'session-' prefix. */
const SESSION_ID_RE = /^(session-)?[0-9a-fA-F-]+$/;
/** Folder ids are always server-issued UUIDs. */
const FOLDER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


const folderSchema = z.object({
	id: z.string(),
	workspaceId: z.string(),
	name: z.string(),
	sessionIds: z.array(z.string()),
	// Display order within the workspace; legacy records carry no index and
	// sort last (falling back to name order) until first reordered.
	sortIndex: z.number().int().min(0).optional(),
	// Sessions pinned at the top of this folder, in pin order.
	pinnedSessionIds: z.array(z.string()).optional()
});

/**
* The plug-in's own storage domain: one global record holding every folder.
* Orphaned folder records (workspace deleted) are filtered at list time —
* there is no workspace-delete hook, so records are never proactively
* removed; they simply stop being served. Sessions are never stored here:
* membership rides the folder records only, and a session not listed in any
* folder is loose by definition.
*/
/** Storage-domain name; also the name a reload finds an already-open domain under. */
const DOMAIN_NAME = "dsh_session_folders";
/** Bounded wait for another entry generation that is still opening (or holding) the domain. */
const DOMAIN_OPEN_ATTEMPTS = 40;
const DOMAIN_OPEN_DELAY_MS = 50;
const foldersDomainSpec = defineDomain({
	name: DOMAIN_NAME,
	version: 1,
	global: {
		schema: z.object({
			folders: z.array(folderSchema),
			// Display order of workspace ids, maintained by reorder-workspaces.
			workspaceOrder: z.array(z.string()).optional(),
			// Sessions pinned at the top of a workspace's loose bucket, per workspace.
			pinnedLooseByWorkspace: z.record(z.string(), z.array(z.string())).optional()
		}),
		initial: { folders: [], workspaceOrder: [], pinnedLooseByWorkspace: {} }
	},
	tables: {}
});

/** Accumulate the raw request body with a size guard. */
function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (chunk) => {
			data += chunk;
			if (data.length > MAX_BODY_BYTES) {
				req.destroy();
				const err = new Error("request body too large");
				err.clientError = true;
				reject(err);
			}
		});
		req.on("end", () => {
			if (data.length === 0) return resolve({});
			try {
				resolve(JSON.parse(data));
			} catch {
				const err = new Error("invalid JSON body");
				err.clientError = true;
				reject(err);
			}
		});
		req.on("error", reject);
	});
}

/** Write a JSON response with an explicit content-length. */
function respond(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body)
	});
	res.end(body);
}

/**
* Resolve the workspace entity that currently owns a session, using the
* registry's canonical-cwd-filtered sessionIds view. A session whose path no
* longer canonicalizes to its workspace is unaccounted (lives in the
* Ungrouped bucket) — moving it into a folder is impossible by contract.
* @param ctx - cordis context (workspaceRegistry service).
* @param sessionId - session to look up.
* @returns the owning workspace entity, or undefined when unaccounted.
*/
function owningWorkspace(ctx, sessionId) {
	return ctx.workspaceRegistry.list().find((workspace) => workspace.sessionIds.includes(sessionId));
}

/**
* Cordis plug-in entry: open the domain, register the routes.
*
* A configuration reload mounts the next generation before the previous one is
* disposed. The shared storage domain and the route paths are process-wide, so both
* are claimed defensively here: a reload, a reinstall, or an entry toggle must not
* be able to fail the load (an `already-open` domain or a duplicate route path is a
* fatal host failure, not a per-entry one).
*/
function apply(ctx) {
	/**
	* Resolve the shared domain, tolerating a generation that is mid-open.
	*
	* `open` reserves the name before its first await and publishes the domain only when the
	* load settles, so a generation that mounts while another is still opening sees neither a
	* live domain nor a free name — and `already-open` is a fatal load failure, not a retryable
	* one. Wait, bounded, for the other generation to publish it.
	* @returns the live or freshly opened domain.
	*/
	const resolveDomain = async () => {
		for (let attempt = 0; ; attempt += 1) {
			const live = ctx.storageDomain.get(DOMAIN_NAME);
			if (live !== void 0) return live;
			try {
				return await ctx.storageDomain.open(foldersDomainSpec);
			} catch (error) {
				if (attempt >= DOMAIN_OPEN_ATTEMPTS || error?.code !== "already-open") throw error;
				await new Promise((resolve) => ctx.setTimeout(resolve, DOMAIN_OPEN_DELAY_MS));
			}
		}
	};
	return resolveDomain().then((foldersDomain) => {
		const getFolders = () => foldersDomain.global.get().folders;
		/**
		* Persist a new folder record set. The domain's write chain guarantees
		* durability-first ordering per write; the in-process tail below
		* additionally serializes the read-modify-write of the shared global
		* record across routes, so two browsers cannot lose each other's write.
		*/
		/** Read the shared global record (inside the mutation lock only). */
		const readRecord = () => foldersDomain.global.get();
		/** Persist the record with every optional field defaulted. */
		const writeRecord = (record) => foldersDomain.global.set({
			folders: record.folders,
			workspaceOrder: record.workspaceOrder ?? [],
			pinnedLooseByWorkspace: record.pinnedLooseByWorkspace ?? {}
		});
		/** Serialize every folder mutation through one promise tail. */
		let mutationTail = Promise.resolve();
		const withMutationLock = (operation) => {
			const result = mutationTail.then(operation, operation);
			mutationTail = result.then(() => void 0, () => void 0);
			return result;
		};
		const ws = ctx.webServer;
		/** Route-claim retries while a previous generation still owns the path (bounded). */
		const ROUTE_RETRY_ATTEMPTS = 200;
		const ROUTE_RETRY_DELAY_MS = 50;
		/**
		* Claim one route path, releasing it when this generation is disposed.
		*
		* The host mounts a new generation before disposing the previous one, and
		* `webServer.register` throws on a duplicate path — which is a fatal load failure for
		* the whole host. Wait, bounded, for the previous owner to release the path; if it never
		* does, it kept the path registered with this same handler code, so the surface stays
		* served either way.
		* @param route - the exact-path route to register.
		* @returns the disposer releasing the path when this generation owned it.
		*/
		const claimRoute = (route) => {
			let release;
			let attempts = ROUTE_RETRY_ATTEMPTS;
			const attempt = () => {
				if (release !== void 0) return;
				try {
					release = ws.register(route);
				} catch (error) {
					if (!String(error?.message ?? "").includes("duplicate") || attempts <= 0) {
						ctx.logger.warn("[dsh-session-folders] route claim stopped:", String(error?.message ?? error));
						return;
					}
					attempts -= 1;
					ctx.setTimeout(attempt, ROUTE_RETRY_DELAY_MS);
				}
			};
			attempt();
			return () => {
				const owned = release;
				release = void 0;
				if (owned !== void 0) owned();
			};
		};
		/** Serve one POST route: same-origin JSON in, JSON response out, uniform error shape. */
		const route = (path, handler) => {
			ctx.effect(() => claimRoute({
				kind: "exact",
				path: ROUTE_PREFIX + "/" + path,
				handler: async (req, res) => {
					if (req.method !== "POST") return respond(res, 405, { error: "method-not-allowed" });
					// CSRF hardening: JSON-only bodies, no cross-site fetches, and an
					// Origin/Host match when a browser sends Origin. Requests without
					// Origin (curl, scripts) stay allowed.
					const contentType = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
					if (contentType !== "application/json") return respond(res, 400, { error: "bad-request" });
					if (req.headers["sec-fetch-site"] === "cross-site") return respond(res, 403, { error: "cross-origin-denied" });
					const origin = req.headers["origin"];
					if (typeof origin === "string" && origin.length > 0) {
						try {
							if (new URL(origin).host !== req.headers.host) return respond(res, 403, { error: "cross-origin-denied" });
						} catch {
							return respond(res, 403, { error: "cross-origin-denied" });
						}
					}
					try {
						const body = await readJsonBody(req);
						await handler(body, res);
					} catch (error) {
						if (error.clientError === true) {
							return respond(res, 400, { error: "bad-request" });
						}
						ctx.logger.warn("[dsh-session-folders] route failed:", error);
						respond(res, 500, { error: "internal-error" });
					}
				}
			}), "dsh-session-folders: " + path + " route");
		};

		route("list", async (body, res) => {
			const alive = new Set(ctx.workspaceRegistry.list().map((workspace) => workspace.id));
			const record = readRecord();
			respond(res, 200, {
				folders: record.folders.filter((folder) => alive.has(folder.workspaceId)),
				workspaceOrder: record.workspaceOrder ?? [],
				pinnedLoose: record.pinnedLooseByWorkspace ?? {}
			});
		});

		route("create", async (body, res) => {
			const workspaceId = body?.workspaceId;
			const folderName = parseFolderName(body);
			if (typeof workspaceId !== "string" || workspaceId.length === 0 || folderName === void 0) {
				return respond(res, 400, { error: "bad-request" });
			}
			if (!ctx.workspaceRegistry.list().some((workspace) => workspace.id === workspaceId)) {
				return respond(res, 404, { error: "workspace-not-found" });
			}
			return withMutationLock(async () => {
				const folders = getFolders();
				if (hasNameConflict(folders, workspaceId, folderName)) {
					return respond(res, 409, { error: "name-conflict" });
				}
				let id;
				do {
					id = randomUUID();
				} while (folders.some((folder) => folder.id === id));
				const maxIndex = folders
					.filter((folder) => folder.workspaceId === workspaceId)
					.reduce((max, folder) => Math.max(max, folder.sortIndex ?? 0), 0);
				const record = readRecord();
				await writeRecord({ ...record, folders: [...record.folders, { id, workspaceId, name: folderName, sessionIds: [], sortIndex: maxIndex + 1 }] });
				respond(res, 200, { id });
			});
		});

		route("rename", async (body, res) => {
			const folderId = body?.folderId;
			const folderName = parseFolderName(body);
			if (typeof folderId !== "string" || folderId.length === 0 || folderName === void 0) {
				return respond(res, 400, { error: "bad-request" });
			}
			return withMutationLock(async () => {
				const folders = getFolders();
				const folder = folders.find((candidate) => candidate.id === folderId);
				if (folder === void 0) return respond(res, 404, { error: "folder-not-found" });
				if (hasNameConflict(folders, folder.workspaceId, folderName, folderId)) {
					return respond(res, 409, { error: "name-conflict" });
				}
				const record = readRecord();
				await writeRecord({ ...record, folders: record.folders.map((candidate) =>
					candidate.id === folderId ? { ...candidate, name: folderName } : candidate
				) });
				respond(res, 200, { ok: true });
			});
		});

		route("delete", async (body, res) => {
			const folderId = body?.folderId;
			if (typeof folderId !== "string" || folderId.length === 0) {
				return respond(res, 400, { error: "bad-request" });
			}
			return withMutationLock(async () => {
				const folders = getFolders();
				if (!folders.some((folder) => folder.id === folderId)) {
					return respond(res, 404, { error: "folder-not-found" });
				}
				// Drop the record: its sessions become loose in that workspace.
				// Pins of the deleted folder die with it (loose again, unpinned).
				const record = readRecord();
				await writeRecord({ ...record, folders: record.folders.filter((folder) => folder.id !== folderId) });
				respond(res, 200, { ok: true });
			});
		});

		route("move", async (body, res) => {
			// Session ids are canonical in the "session-<uuid>" form: the
			// workspace registry keys sessions by the full prefixed id. Use the
			// id exactly as sent — any normalization would break membership.
			const sessionId = body?.sessionId;
			const folderId = body?.folderId;
			if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
				return respond(res, 400, { error: "bad-request" });
			}
			if (folderId !== null && (typeof folderId !== "string" || !FOLDER_ID_RE.test(folderId))) {
				return respond(res, 400, { error: "bad-request" });
			}
			return withMutationLock(async () => {
				const record = readRecord();
				// Pin state follows the session across a move: remember whether
				// it was pinned in its current location, strip it from every
				// pinned list, then restore it at the top of the target list.
				const owner = owningWorkspace(ctx, sessionId);
				const sessionWorkspaceId = owner?.id;
				const wasPinned = record.folders.some((folder) => (folder.pinnedSessionIds ?? []).includes(sessionId)) ||
					(sessionWorkspaceId !== void 0 && record.pinnedLooseByWorkspace[sessionWorkspaceId]?.includes(sessionId) === true);
				// The session is always removed from every folder first; the
				// inbox target (folderId null) is just that removal.
				const without = record.folders.map((folder) => ({
					...folder,
					sessionIds: folder.sessionIds.filter((id) => id !== sessionId),
					pinnedSessionIds: (folder.pinnedSessionIds ?? []).filter((id) => id !== sessionId)
				}));
				const pinnedLoose = Object.fromEntries(Object.entries(record.pinnedLooseByWorkspace ?? {}).map(([key, ids]) => [key, ids.filter((id) => id !== sessionId)]));
				if (folderId === null) {
					const nextLoose = wasPinned && sessionWorkspaceId !== void 0
						? { ...pinnedLoose, [sessionWorkspaceId]: [sessionId, ...(pinnedLoose[sessionWorkspaceId] ?? [])] }
						: pinnedLoose;
					await writeRecord({ ...record, folders: without, pinnedLooseByWorkspace: nextLoose });
					return respond(res, 200, { ok: true });
				}
				const target = without.find((folder) => folder.id === folderId);
				if (target === void 0) return respond(res, 404, { error: "folder-not-found" });
				// Cross-workspace moves are impossible: the target folder must
				// be the workspace that currently owns the session. A session
				// outside every workspace (canonical-cwd strays) can never
				// match any folder's workspace.
				if (owner === void 0 || owner.id !== target.workspaceId) {
					return respond(res, 409, { error: "session-not-in-workspace" });
				}
				await writeRecord({
					...record,
					folders: without.map((folder) =>
						folder.id === folderId
							? { ...folder, sessionIds: [sessionId, ...folder.sessionIds], pinnedSessionIds: wasPinned ? [sessionId, ...(folder.pinnedSessionIds ?? [])] : folder.pinnedSessionIds }
							: folder
					),
					pinnedLooseByWorkspace: pinnedLoose
				});
				respond(res, 200, { ok: true });
			});
		});

		route("reorder-folders", async (body, res) => {
			const workspaceId = body?.workspaceId;
			const orderedIds = body?.orderedIds;
			if (typeof workspaceId !== "string" || workspaceId.length === 0 || !Array.isArray(orderedIds)) {
				return respond(res, 400, { error: "bad-request" });
			}
			if (!orderedIds.every((id) => typeof id === "string" && id.length > 0)) {
				return respond(res, 400, { error: "bad-request" });
			}
			return withMutationLock(async () => {
				const folders = getFolders();
				if (!ctx.workspaceRegistry.list().some((workspace) => workspace.id === workspaceId)) {
					return respond(res, 404, { error: "workspace-not-found" });
				}
				// The client must submit exactly the workspace's folder id set:
				// no missing ids (would drop folders from the order), no extras,
				// no duplicates.
				const owned = folders.filter((folder) => folder.workspaceId === workspaceId);
				const ownedIds = new Set(owned.map((folder) => folder.id));
				if (!isExactIdSet(orderedIds, ownedIds)) {
					return respond(res, 400, { error: "bad-request" });
				}
				const indexOf = new Map(orderedIds.map((id, index) => [id, index]));
				const record = readRecord();
				await writeRecord({ ...record, folders: record.folders.map((folder) =>
					folder.workspaceId === workspaceId ? { ...folder, sortIndex: indexOf.get(folder.id) } : folder
				) });
				respond(res, 200, { ok: true });
			});
		});

		route("reorder-workspaces", async (body, res) => {
			const orderedIds = body?.orderedIds;
			if (!Array.isArray(orderedIds) || !orderedIds.every((id) => typeof id === "string" && id.length > 0)) {
				return respond(res, 400, { error: "bad-request" });
			}
			return withMutationLock(async () => {
				// The client must submit the full live workspace id set exactly.
				const live = ctx.workspaceRegistry.list().map((workspace) => workspace.id);
				const liveSet = new Set(live);
				if (!isExactIdSet(orderedIds, liveSet)) {
					return respond(res, 400, { error: "bad-request" });
				}
				const record = readRecord();
				await writeRecord({ ...record, workspaceOrder: orderedIds });
				respond(res, 200, { ok: true });
			});
		});

		route("pin", async (body, res) => {
			const sessionId = body?.sessionId;
			const pinned = body?.pinned;
			if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId) || typeof pinned !== "boolean") {
				return respond(res, 400, { error: "bad-request" });
			}
			return withMutationLock(async () => {
				const record = readRecord();
				// A session in a folder pins inside that folder; a loose session
				// pins at the top of its workspace's loose bucket. Either case
				// is idempotent: re-pinning or unpinning a non-pinned session is
				// a no-op that still succeeds.
				const holder = record.folders.find((folder) => folder.sessionIds.includes(sessionId));
				if (holder !== void 0) {
					const current = holder.pinnedSessionIds ?? [];
					if (pinned && !current.includes(sessionId)) {
						await writeRecord({ ...record, folders: record.folders.map((folder) =>
							folder.id === holder.id ? { ...folder, pinnedSessionIds: [sessionId, ...current] } : folder
						) });
					} else if (!pinned && current.includes(sessionId)) {
						await writeRecord({ ...record, folders: record.folders.map((folder) =>
							folder.id === holder.id ? { ...folder, pinnedSessionIds: current.filter((id) => id !== sessionId) } : folder
						) });
					}
					return respond(res, 200, { ok: true });
				}
				// A session outside every workspace (Ungrouped) cannot be pinned.
				const owner = owningWorkspace(ctx, sessionId);
				if (owner === void 0) return respond(res, 409, { error: "session-not-in-workspace" });
				const current = (record.pinnedLooseByWorkspace ?? {})[owner.id] ?? [];
				if (pinned && !current.includes(sessionId)) {
					await writeRecord({ ...record, pinnedLooseByWorkspace: { ...record.pinnedLooseByWorkspace, [owner.id]: [sessionId, ...current] } });
				} else if (!pinned && current.includes(sessionId)) {
					await writeRecord({ ...record, pinnedLooseByWorkspace: { ...record.pinnedLooseByWorkspace, [owner.id]: current.filter((id) => id !== sessionId) } });
				}
				respond(res, 200, { ok: true });
			});
		});


		route("unarchive", async (body, res) => {
			const sessionId = body?.sessionId;
			if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
				return respond(res, 400, { error: "bad-request" });
			}
			// The archive set is a registry-global record in the "workspace"
			// storage domain. There is no public unarchive API (dsh-session-
			// manager precedent): filter the id out of the durable record and
			// poke the registry's private state cache so the next
			// archiveSession() call sees the truth instead of idempotently
			// skipping on the stale set. The whole read-filter-write-poke runs
			// inside the registry's operation queue when available, so a
			// concurrent archive from another browser cannot lose our write;
			// without the queue this degrades to a direct write with a warning.
			const registry = ctx.workspaceRegistry;
			const enqueue = typeof registry?.enqueueOperation === "function"
				? (operation) => registry.enqueueOperation(operation)
				: (operation) => {
					ctx.logger.warn("[dsh-session-folders] unarchive: registry queue unavailable, direct write fallback");
					return operation();
				};
			await enqueue(async () => {
				const workspace = ctx.storageDomain.get("workspace");
				const state = workspace?.global.get();
				if (workspace === void 0 || !Array.isArray(state?.archivedSessionIds)) {
					return respond(res, 500, { error: "workspace-internals-changed" });
				}
				if (!state.archivedSessionIds.includes(sessionId)) return respond(res, 200, { ok: true });
				const next = {
					...state,
					archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId)
				};
				await workspace.global.set(next);
				if ("state" in registry) registry.state = next;
				respond(res, 200, { ok: true });
			});
		});

		// No domain disposer on purpose: the domain belongs to the process, not to this entry
		// generation. A reload mounts the replacement before disposing this one, so the newcomer
		// reuses this domain — closing it here would hand the newcomer a dead handle. Route
		// effects release their own paths; storageDomain.closeAll() owns shutdown.
		return void 0;
	});
}

export { apply, inject, name };