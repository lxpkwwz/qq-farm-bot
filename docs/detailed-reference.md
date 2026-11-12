# 详细参考

根 [README](../README.md) 只保留快速上手需要的内容。本页收录完整的配置说明、开发命令、项目结构、来源与许可信息，供需要深入配置或二次开发时查阅。

示例命令默认从仓库根目录执行。

## 目录

- [部署细节](#部署细节)
- [账号登录细节](#账号登录细节)
- [配置说明](#配置说明)
- [数据与备份](#数据与备份)
- [项目结构](#项目结构)
- [开发命令](#开发命令)
- [清理构建产物](#清理构建产物)
- [抓包协议分析](#抓包协议分析)
- [专题文档](#专题文档)
- [来源与合并](#来源与合并)
- [许可证](#许可证)
- [免责声明](#免责声明)

<a name="部署细节"></a>

## 部署细节

### 运行环境要求

| 运行方式 | 要求 |
| --- | --- |
| 源码运行 | Node.js 20.19+、Git、pnpm 10（推荐 Node.js 24 LTS 或 22 LTS，本项目锁定 pnpm `10.30.2`） |
| Docker | Docker 20+、Docker Compose 2+，Node 由镜像内置 |
| 二进制发布版 | 无需安装 Node.js |

`pnpm dev:core` 只启动后端，因此需要先构建一次前端；想一步到位也可以用 `pnpm dev`，它会先构建前端再启动后端。

### 一条命令常驻（Linux / macOS）

```bash
git clone https://github.com/602832789/qq-farm-bot.git
cd qq-farm-bot
corepack enable
bash ./start.sh

# 忽略缓存、完整重建
bash ./start.sh --rebuild

# 查看日志
tail -f app_dev.log

# 停止服务
bash ./stop.sh
```

`start.sh` 会在依赖缺失或依赖清单变化时执行 `pnpm install --frozen-lockfile`，并按文件更新时间分别判断 Web、Core 是否需要重建；源码和依赖都没变时直接复用现有产物。脚本随后以生产模式后台运行 `node core/client.js`，日志写入 `app_dev.log`，进程号记录在 `app_dev.pid`。`stop.sh` 会校验 PID 对应的工作目录和启动命令，再停止整个服务进程组。

Windows 用户可以直接双击 `start.bat`：脚本会自动检查端口占用、安装依赖、构建前端，然后在新窗口启动面板；`stop.bat` 用于停止。

### 开发模式

```bash
# 终端 1：Vite 前端开发服务
pnpm dev:web

# 终端 2：后端开发服务
pnpm dev:core
```

前端类型检查已与生产构建拆分，需要单独检查时执行 `pnpm typecheck:web`。

### 端口与依赖布局

- Web 面板监听端口由 `ADMIN_PORT` 决定，未设置时默认 `3007`。
- Vite 开发服务的 `/api`、`/socket.io` 等请求都代理到 `http://localhost:3007`，改端口时两处要一起改。
- 仓库根目录的 `.npmrc` 设置了 `node-linker=hoisted`，让 `node_modules` 使用扁平布局。pnpm 默认的符号链接布局下，`tsc` 无法为 Express 推断出可移植的类型命名（TS2742），会中断 `core` 构建，请不要删除这个文件。

### Docker 完整命令

```bash
git clone https://github.com/602832789/qq-farm-bot.git
cd qq-farm-bot
docker compose up -d --build

# 仅重启现有容器，不触发镜像构建
docker compose restart qq-farm-bot

# 查看状态和日志
docker compose ps
docker compose logs -f

# 检查 Compose 配置展开结果
docker compose config

# 停止并移除容器
docker compose down
```

根目录 `.env` 中的 `PORT` 只控制宿主机映射端口，容器内部固定监听 `3007`：

```dotenv
PORT=3007
TZ=Asia/Shanghai
NODE_ENV=production
```

Docker 数据保存在 `qq-farm-data` 和 `qq-farm-logs` 两个命名卷中，`docker compose down` 不会删除它们；除非确认要清空运行数据，不要使用 `docker compose down -v`。

Compose 以根目录作为构建上下文，Dockerfile 位于 `core/Dockerfile`。构建阶段固定 Node `20.19.6` 与 pnpm `10.30.2`，通过 BuildKit 缓存 pnpm store，并在相互独立的阶段分别构建 Web、Core 和生产依赖，只改一侧源码时可复用另一侧缓存；运行阶段只保留生产依赖、编译产物、协议定义、游戏配置与 TSDK WASM。健康检查每 30 秒请求一次 `/api/game-version`。

依赖默认走 npm 官方源，网络受限时可在根目录 `.env` 覆盖构建参数后重新构建：

```dotenv
NPM_REGISTRY=https://registry.npmmirror.com/
```

需要显式指定基础镜像或 pnpm 版本时，可以配置 `NODE_IMAGE` 和 `PNPM_VERSION`；改过构建参数或怀疑缓存有问题时执行 `docker compose build --pull --no-cache`。

QQ 扫码登录所需的 NapCat 不包含在 `docker-compose.yml` 里——Compose 默认只启动农场服务本身。仓库的 `napcat/` 目录提供了容器构建上下文：基于 `mlikiowa/napcat-docker` 镜像，并内置 `qq-miniapp-openauth` 插件。需要时在仓库根目录自行构建并运行：

```bash
docker build -f napcat/Dockerfile -t qq-farm-napcat .
docker run -d --name qq-farm-napcat --restart unless-stopped qq-farm-napcat
```

镜像同时提供 amd64 与 arm64，不提供 32 位 x86。启动后把它的可访问地址和接口签名填到面板的登录设置里。

NapCat 的上游源码仓库已经下线，`mlikiowa/napcat-docker:latest` 作为浮动标签不再有任何可用性保证：它既可能在无人知晓的情况下指向另一个版本，也可能在镜像被清理后直接拉不到。生产部署建议把基础镜像固定到明确版本，让每次重建都落到同一个 NapCat 上：

```bash
docker build -f napcat/Dockerfile -t qq-farm-napcat \
  --build-arg NAPCAT_IMAGE=mlikiowa/napcat-docker:<版本号> .
```

如果 `docker.io` 在当前网络下无法直连，构建会卡在拉取基础镜像这一步。注意 `docker manifest inspect` 是由 CLI 直接连接 registry 的，**不经过宿主机的 `registry-mirrors` 配置**，所以它报连接超时既不能证明版本不存在，也不能用来判断标签可用性；要验证标签请改用 `docker pull`，它才会走镜像加速。无法直连时把 `NAPCAT_IMAGE` 换成加速站前缀的完整地址：

```bash
docker build -f napcat/Dockerfile -t qq-farm-napcat \
  --build-arg NAPCAT_IMAGE=docker.m.daocloud.io/mlikiowa/napcat-docker:<版本号> .
```

宿主机上已经有这个镜像时，把 `NAPCAT_IMAGE` 直接写成 `docker images` 里显示的本地标签即可，构建阶段不会产生任何拉取。

如果镜像仓库和加速站都不可达，可以改走离线导入：社区维护的 NapCat 归档仓库在 release 产物里保留了分架构的 `napcat-docker-v<版本号>-<架构>.tar`，下载后在本机导入，再按上面的 `--build-arg` 指向本地标签即可，全程不需要访问任何 registry：

```bash
docker load -i napcat-docker-v<版本号>-amd64.tar
```

导入后的镜像名以 `docker images` 显示为准；镜像若没有名字，可以先 `docker tag <镜像ID> napcat-docker:<版本号>` 再构建。

### 二进制部署

不想装 Node.js 时，可从 [Releases](https://github.com/602832789/qq-farm-bot/releases) 下载对应平台的可执行文件，也可以自行构建：

```bash
pnpm install
pnpm package:release
```

Windows x64、Linux x64、macOS Intel 和 macOS Apple Silicon 产物生成在 `core/dist/bin/`。程序运行后会在可执行文件同级创建 `data/` 目录，所有运行数据都放在那里。

Linux 和 macOS 首次运行可能需要执行权限：

```bash
chmod +x ./qq-farm-bot
./qq-farm-bot
```

### 更新源码部署

先停止当前服务，再拉取代码、安装依赖并重新构建：

```bash
git pull --ff-only
pnpm install
pnpm build:web
pnpm dev:core
```

Docker 部署先执行 `git pull --ff-only`，再执行 `docker compose up -d --build`。

<a name="账号登录细节"></a>

## 账号登录细节

1. 打开 Web 面板，用 `admin` / `admin` 登录。
2. 进入「设置 → 系统设置」修改管理员密码。
3. 添加游戏账号：抓包 Code 登录、微信扫码登录、QQ 扫码登录三种方式任选。
4. 为账号配置种植、自动化和好友策略，按需设置实例级下线提醒。
5. 启动账号，在概览页确认连接状态、农场数据和实时日志。

Code 有时效性，登录失败时先重新获取 Code 或重新扫码。QQ 客户端被挤下线后，官方“重新登录”会签发新的 Code；可启动 QQFarmCodeHelper 的标准获取模式并开启自动同步，再点击官方“重新登录”，Helper 会更新匹配账号的 Code 并重新拉起远程账号。协议监听模式只落盘抓包，永远不会自动上传 Code。

QQ 扫码登录依赖外部的 [qq-miniapp-auth](https://github.com/liyangpengs/qq-miniapp-auth) 服务：在「设置 → 系统设置 → 登录设置」开启后，填写该服务的可访问地址和与之 `API_SIGNING_SECRET` 一致的接口签名，两项都配置好才能开启。凭据保存在本机数据目录，由后端调用外部服务时读取。

<a name="配置说明"></a>

## 配置说明

### 环境变量

| 变量 | 默认值 | 适用范围 | 说明 |
| --- | --- | --- | --- |
| `ADMIN_PORT` | `3007` | 源码、二进制 | Web 面板监听端口；Compose 容器内固定为 `3007` |
| `PORT` | `3007` | Docker Compose | 宿主机映射端口，从根目录 `.env` 读取 |
| `TZ` | `Asia/Shanghai` | Docker Compose | 容器时区 |
| `NODE_ENV` | `production` | Docker | Compose 当前固定为生产环境 |
| `LOG_LEVEL` | `info` | 后端 | 服务端日志级别 |

管理员不通过环境变量初始化：首次运行自动创建 `admin` / `admin`，之后的凭据保存在数据目录的 `admin.json` 中。面板只保留一个超级管理员，不提供注册、普通用户和租户隔离。

### 种植策略

| 策略值 | 面板名称 | 行为 |
| --- | --- | --- |
| `preferred` | 优先种植种子 | 优先使用指定种子，不可用时自动回退 |
| `level` | 最高等级作物 | 优先选择当前可种植的高等级作物 |
| `max_exp` | 最大经验/时 | 按单位时间经验选择，默认策略 |
| `max_fert_exp` | 最大普通肥经验/时 | 按普通肥条件下的单位时间经验选择 |
| `max_profit` | 最大净利润/时 | 按单位时间净利润选择 |
| `max_fert_profit` | 最大普通肥净利润/时 | 按普通肥条件下的单位时间净利润选择 |
| `bag_priority` | 背包种子优先 | 先按优先级消耗背包种子，再使用回退策略 |

### 施肥模式

| 模式值 | 面板名称 | 行为 |
| --- | --- | --- |
| `smart` | 普通 + 快成熟有机 | 默认模式，按成熟时间智能选择有机肥 |
| `both` | 普通 + 有机 | 同时使用普通肥和有机肥 |
| `normal` | 仅普通化肥 | 只使用普通化肥 |
| `organic` | 仅有机化肥 | 只使用有机化肥 |
| `none` | 不施肥 | 关闭自动施肥 |

`smart` 模式施加有机肥后会重新检查一次自有土地，并立即收获本轮因施肥进入成熟状态的作物；该追收最多执行一次，不会形成循环请求。

### 图鉴配置

图鉴使用 `core/src/gameConfig/Illustrated.json` 和 `core/src/gameConfig/BuffCfg.json` 两份游戏配置：

| 配置 | 字段 | 说明 |
| --- | --- | --- |
| `Illustrated.json` | `param` | 与图鉴协议返回的果实 ID 对应 |
| `Illustrated.json` | `type` | 果实分类：普通果实、黄金果实、活动果实、装扮果实 |
| `Illustrated.json` | `illustrated_type` | 区分普通图鉴和超变图鉴 |
| `Illustrated.json` | `sort` | 图鉴中的展示顺序 |
| `BuffCfg.json` | `source_type` | 超变图鉴只展示「超变升级」，隐藏「活动加成」 |
| `BuffCfg.json` | `source_param` | 触发该属性加成的图鉴等级 |
| `BuffCfg.json` | `attr_id` | 属性加成名称 |
| `BuffCfg.json` | `attr_value` | 大于 `10` 时为触发概率，小于 `10` 时为数量 |

概率值按千分值换算为百分比展示，例如 `100` 显示 `10%`、`500` 显示 `50%`；数量值直接展示，例如 `2` 显示「数量 +2」。当前加成按属性名称取当前等级已生效的最新配置。

<a name="数据与备份"></a>

## 数据与备份

| 运行方式 | 数据位置 |
| --- | --- |
| 源码运行 | `core/data/` |
| 二进制运行 | 可执行文件同级的 `data/` |
| Docker | `/app/core/data`，映射到 `qq-farm-data` 命名卷 |

管理员凭据、游戏账号、配置、活动状态和日志都属于运行数据。升级、迁移或重新部署前，建议先停止服务并备份整个数据目录或 Docker 命名卷，而不是只复制单个 JSON 文件。

游戏账号属于当前实例，不带用户归属字段，也没有数量上限；下线提醒同样是实例级配置，对实例内所有游戏账号生效。

不要将数据目录、`.env`、日志或密钥提交到公开仓库。

<a name="项目结构"></a>

## 项目结构

```text
qq-farm-bot/
├── core/                  # Node.js 后端、账号 Worker 与协议实现
│   ├── src/
│   │   ├── controllers/   # Web API 与鉴权路由
│   │   ├── core/          # 单账号 Worker 与任务调度
│   │   ├── runtime/       # 多账号运行时和状态同步
│   │   ├── services/      # 农场、好友、图鉴、活动、商城、微信登录等业务
│   │   ├── proto/         # Protocol Buffers 定义
│   │   ├── gameConfig/    # 作物、道具、等级、图鉴与属性加成等游戏配置
│   │   └── models/        # 超级管理员、游戏账号与配置持久化
│   └── data/              # 源码模式运行数据
├── web/                   # Vue 3 Web 面板
│   ├── src/components/    # 农场、图鉴、背包、任务、活动与基础组件
│   ├── src/stores/        # Pinia 状态管理
│   ├── src/views/         # 各功能页面
│   └── dist/              # 前端构建产物
├── docs/                  # 项目专题文档
├── tools/                 # 配置下载、图片下载与协议分析工具
├── docker-compose.yml
├── pnpm-workspace.yaml
└── package.json
```

<a name="开发命令"></a>

## 开发命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 构建前端并启动后端开发服务 |
| `pnpm dev:web` | 启动 Vite 前端开发服务 |
| `pnpm dev:core` | 使用 `tsx` 启动后端 |
| `pnpm lint` | 检查并自动修复前后端代码风格 |
| `pnpm -C core typecheck` | 后端 TypeScript 类型检查 |
| `pnpm typecheck:web` | 前端 TypeScript 类型检查（不参与生产启动） |
| `pnpm build:web` | 构建 Web 面板到 `web/dist/` |
| `pnpm -C web build:compressed` | 构建 Web 并额外生成预压缩 `.gz` 文件 |
| `pnpm -C web build:analyze` | 构建 Web 并生成 bundle 分析报告 |
| `pnpm build:core` | 编译后端 TypeScript |
| `pnpm build` | 依次构建前端和后端 |
| `pnpm package:release` | 构建四个平台的独立二进制文件 |
| `pnpm -C core test` | 编译 Core 并运行抓包协议、活动和请求并发测试 |

<a name="清理构建产物"></a>

## 清理构建产物

```bash
# Linux/macOS
bash ./clean.sh

# Windows
clean-for-pack.bat

# 保留 core/data 运行数据
clean-for-pack.bat --keep-data
```

`clean.sh` 会停止当前服务，然后删除项目根目录下除 `.git` 以外的全部文件和目录，包括源码、依赖、构建产物、运行数据以及脚本自身。该操作不可撤销，只应用于准备通过 Git 重新检出工作区的场景。

`clean-for-pack.bat` 会清理依赖、构建产物、覆盖率文件、日志以及 `core/data` 运行数据，适合生成不包含账号和凭据的发布目录；需要保留 `core/data` 时必须显式传入 `--keep-data`。

<a name="抓包协议分析"></a>

## 抓包协议分析

```bash
# 解码指定抓包目录中的协议帧
pnpm -C core exec tsx ../tools/decode-latest-protocols.js <capture-dir>

# 检查抓包 RPC 与本地 Protobuf 定义的兼容性
pnpm -C core exec tsx ../tools/audit-capture-compatibility.js <capture-dir>
```

<a name="专题文档"></a>

## 专题文档

专题说明统一收录在 [`docs/`](README.md)：

- [工具脚本](tools.md)
- [网络并发模型](network-concurrency.md)
- [TSDK Node.js 运行约定](tsdk-runtime.md)
- [配置存储、迁移与缓存](config-storage.md)
- [2026-10-22 游戏版本与资源对齐](game-update-20261022.md)
- [雨落成诗活动协议与实现](weather-activity.md)
- [神秘商人、游戏商城与购买协议](shop-protocols.md)
- [好友宠物缓存与每日同步](friend-pet-cache.md)
- [个人页宠物协议](pet-protocols.md)
- [图鉴、变异宝典与藏品](collections-20261101.md)
- [上游同步手册](upstream-sync-runbook.md)
- [小程序跳转与访问协议](visit-enter-protocol.md)
- [更新记录](CHANGELOG.md)

仓库根目录的 [`AGENTS.md`](../AGENTS.md) 记录了仓库约定、QQ 小游戏源码与资源缓存位置，以及 WASM 更新流程，适合交给 AI 助手作为上下文。

<a name="来源与合并"></a>

## 来源与合并

本项目由两个上游合并而成：代码实现以较新的功能分支为准，项目门面与许可证来自主干仓库。

| 角色 | 仓库 | 说明 |
| --- | --- | --- |
| 主干 / 门面 | [BuildAtDawn/qq-farm-bot](https://github.com/BuildAtDawn/qq-farm-bot) | 提供 `LICENSE`、文档与启停脚本约定 |
| 功能 / 内容 | [muyuewang/qq-farm-bot-404](https://github.com/muyuewang/qq-farm-bot-404) | 最新代码实现、协议版本与测试基线 |

两者均源自 [liyangpengs/qq-farm-bot](https://github.com/liyangpengs/qq-farm-bot)。合并规则：

- 两边同名的 2727 个文件中，内容不一致的 106 个全部采用功能分支版本（TS 模块化 `core/src/controllers/admin/*`、`runtime-engine`、最新 Vue 组件与 store）。
- 保留主干独有的 4 个增量文件：`LICENSE`、`restart.sh`、`docs/upstream-sync-runbook.md`、`docs/visit-enter-protocol.md`。
- 不并入主干中被取代的 503 个文件（旧扁平 JS controllers、旧 Vue 组件、针对旧实现的测试用例、前端未引用的静态资源），避免死代码与失败用例进入测试基线。
- 移除了原功能分支的自动 rebase + force-push 同步流水线，避免其覆盖本仓库历史。

合并后共 560 个提交，保留了双方绝大部分历史（主干 16 个 + 功能分支 544 个 + 合并与整理提交）。原功能分支中 3 个新增或修改该同步流水线的提交已从历史中剔除（GitHub 要求推送 `.github/workflows/` 变更的凭据额外具备 `workflow` 权限），文件树不受影响，仓库中也不存在任何 GitHub Actions 配置。

<a name="许可证"></a>

## 许可证

本项目沿用主干的 [PolyForm Noncommercial License 1.0.0](../LICENSE)。这是“可查看源码的非商业许可证”，**不是** OSI 认可的开源许可证。

除许可证明确允许的非商业用途外，未经著作权人另行书面授权，不得将本项目或其修改版用于任何商业目的，包括但不限于：

- 付费倒卖、源码售卖、收费下载、收费授权或商业软件集成；
- 付费代部署、托管、租赁、SaaS、账号托管或按次/按量提供服务；
- 以本项目为基础进行收费的二次开发、定制、分发、培训或技术支持；
- 通过会员、订阅、兑换码、授权码、访问卡或其他方式收费或限制访问。

不得通过更改项目名称、界面、打包方式、增加代理服务或拆分组件来规避上述限制。自建、学习、研究、测试、个人娱乐以及符合许可证定义的非商业组织用途，不等于获得商业授权。

<a name="免责声明"></a>

## 免责声明

本项目仅供学习、研究、测试和个人非商业用途。使用自动化工具可能违反游戏服务条款或其他规则，也可能导致账号限制、数据丢失、服务中断、法律争议或其他损失。使用者应自行承担全部风险和责任，作者不提供任何明示或默示担保，也不对使用结果负责。

作者未授权任何第三方以本项目名义收费、牟利、承诺账号安全或提供官方支持。通过付费渠道获取的服务或副本，与作者无关；相关纠纷应直接联系收费方。

## 致谢

感谢 [liyangpengs/qq-farm-bot](https://github.com/liyangpengs/qq-farm-bot)、[BuildAtDawn/qq-farm-bot](https://github.com/BuildAtDawn/qq-farm-bot)、[muyuewang/qq-farm-bot-404](https://github.com/muyuewang/qq-farm-bot-404) 及所有上游贡献者。
