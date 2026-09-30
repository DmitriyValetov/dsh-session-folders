# Fork notes — dsh-session-folders для DSH 0.2.0-rc.1

Это **форк** плагина [`dsh-session-folders`](https://github.com/EugeneVl/dsh_session_folders) версии 0.4.3 (MIT, автор Eugene).
Оригинал написан под DSH 0.1.x; этот форк портирован под клиентский и хостовый контракт **DSH 0.2.0-rc.1** (desktop-профиль
приложения DeepSeek Harness 0.2.0-rc.1). Оригинальный README (`README.md`) описывает поведение плагина — оно сохранено.

## Зачем порт

| Что сломалось бы | Причина | Что сделано |
|---|---|---|
| `require("@deepseek-ai/dsh-client-runtime/client")` | в 0.2.0 такого клиентского пакета нет | модуль заменён на платформенный seed `@deepseek-ai/dsh-client-store` (`defineStore` там с тем же контрактом `{init, persist, actions}`) |
| `ctx.sessions.open`, `ctx.workspaces.pickDirectory/startSession/connectWorkspace` | в 0.2.0 навигация, архив и выбор каталога переехали в сервис `uiWorkspace` | вызовы переведены на `ctx.uiWorkspace.*`, сервис добавлен в клиентский `inject` |
| `ctx.workspaces.refresh()` | в 0.2.0 такого метода нет (проекция воркспейсов живёт на changed-кадрах хоста) | no-op |
| `ctx.workspaces.openPath` | удалён; запуск приложений теперь у хоста в `/open-in-app/*` | «открыть папку» ходит в `GET /open-in-app/apps` + `POST /open-in-app/open` (та же связка, что в официальной кнопке) |
| иконки `IconXxx16/20/14` | в 0.1.7+ набор переименован с размерных суффиксов на весовые (`…Regular` / `…Medium`) | 13 имён переименованы (`IconCloseFill14` → `IconCloseFillMedium`, `IconFolderClose16` → `IconFolderCloseRegular`, …) |
| `import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm"`, `defineDomain` из `-dsh-storage-domain`, `zod` | плагин профиля резолвит модули из `~/.dsh/profiles/<profile>/node_modules`, пакеты харнесса туда не попадают | `defineDomain` заинлайнена локально, `zod` объявлен обычной зависимостью, **фича Auto rename удалена** вместе со своим роутом и пунктом меню |
| `dsh.client.inject: [@deepseek-ai/dsh-client-runtime, …]` | этого пакета нет, а остальные не нужны: `client-store` / `ui-primitives` — платформенные seeds | список пуст (как у `dsh-taskboard`) |

Хостовый контракт портить не пришлось: `ctx.webServer.register({kind:'exact'})`, `ctx.storageDomain.open/get`,
`ctx.workspaceRegistry.list()` в 0.2.0 те же.

## Известный баг и фикс (v0.5.1)

`ctx.storageDomain.open()` в 0.2.0 бросает `DomainError: domain 'dsh_session_folders' is already open`, если домен уже
открыт. При переустановке/релоаде новая копия плагина монтируется до dispose старой, и это **валит весь хост**
(`dsh: fatal load failure` → падение приложения Electron, тот же класс, что в апстрим-issue «plugin prevents DSH from
starting»). С v0.5.1 плагин сначала спрашивает `ctx.storageDomain.get(DOMAIN_NAME)` и переиспользует живой домен.

## Проверено

- `node --check lib/index.js`, `node --check lib/client.js`, `node --check lib/folder-utils.js`.
- Сверка по живому приложению 0.2.0-rc.1: занятость и приоритеты слота `sidebar.workspaces`, наличие
  `uiWorkspace` (`openSession`/`archiveSession`/`pickDirectory`/`startSession`/`connectWorkspace`), `sessions.search/fork/binding/searchResultLimit`,
  `workspaces.create/rename/delete/archiveSession`, поля `WorkspaceView` и снимков сессий (`displayTitle`, `pendingInteraction`,
  `archivedSessionIds`, `origin`, `blank`, `updatedAt`), имена всех используемых примитивов и иконок.
- Хостовые роуты отвечают (`POST /dsh-session-folders/list` и т.д.), данные лежат в домене `dsh_session_folders`.

## Не проверено (нужен глаз человека в GUI)

- Пропсы высокоуровневых примитивов (`Menu`, `Modal`, `Toast`, `Tooltip`, `Button`, `StateDot`) между 0.1.x и 0.2.0
  статически не сверить: если меню/диалог отрисуется иначе — правится точечно в `lib/client.js`.
- Удалён Auto rename: в меню сессии этого пункта больше нет (вместе с ним убраны импорт `-dsh-llm`,
  роут `/auto-rename` и сервисы `sessionTitle`/`llm` из хостового `inject`).

## Репозиторий

Исходники форка: https://github.com/DmitriyValetov/dsh-session-folders (тэг `v0.5.0`). Установка из гит-репозитория (собранный `lib/` закоммичен,
build-скриптов нет):

```sh
dsh plugin --profile desktop add 'github:DmitriyValetov/dsh-session-folders#v0.5.2'
```

## Установка / удаление / обновление

Установлено в профиль `desktop` как **`link:`**-зависимость:

```
~/.dsh/profiles/desktop/node_modules/dsh-session-folders -> этот каталог
```

- Правки в `lib/` подхватываются перезагрузкой страницы (⌘R); хостовые правки (роуты) — перезапуском приложения.
- `zod@4.4.3` лежит в `node_modules/` этого каталога (скопирован из профиля, без сети). Если каталог переносить,
  скопировать `node_modules/zod` вместе с ним.
- Удаление: `plugin_manager remove_bundle dsh-session-folders` (или `set_plugin enabled:false` для строки
  `include:dsh-session-folders`). После удаления штатный браузер воркспейсов снова занимает слот автоматически.
- Данные плагина: `~/.dsh/storages/dsh_session_folders.json` (домен `dsh_session_folders`); удаление плагина их не трогает.

Если апстрим выпустит версию под 0.2.x — сравнить с этим форком и, скорее всего, удалить форк в пользу npm-версии.
