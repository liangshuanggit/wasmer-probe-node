# wasmer-probe-node

最小 Node.js 探针：部署到 Wasmer Edge 后验证两件事——
(1) Wasmer 网关是否把 WebSocket 升级转发给应用；
(2) 应用能否出站 TCP 直连任意地址。

只做探针，不实现 VLESS，不含任何节点配置、UUID 或密钥。
与 Rust 版探针（`../wasmer-probe/`）端点行为一致，只是换成 Node 实现，
走 Anybuild 的 node 预设部署——Rust WASIX 项目在 Wasmer 控制台直接上传和
GitHub 导入时都被 Anybuild 拒绝识别，而 node 预设是可用的。

## 端点（监听 0.0.0.0:$PORT，$PORT 环境变量，默认 80）

| 端点 | 说明 |
|---|---|
| `GET /` | 200，纯文本 `ok` |
| `GET /ws` | WebSocket 升级握手（RFC 6455，SHA-1 + base64 算 Sec-WebSocket-Accept），握手成功后把收到的文本/二进制帧原样回显；ping 回 pong；握手失败返回 400 说明原因 |
| `GET /dial?host=H&port=P` | 出站 `net.connect`（5 秒超时），成功后发最小 HTTP GET 并读回首批字节；返回纯文本报告：connect 是否成功、耗时、读到的首行或错误信息。host 只允许域名/IPv4，port 1–65535，否则 400 |
| 其他路径 | 404；非 GET 方法 → 405 |

## 本地运行

```sh
node --version   # 需 Node >= 18；本地实测 v24.22.1
node server.js   # 默认监听 0.0.0.0:80；改端口：PORT=8080 node server.js
```

测试：

```sh
curl http://127.0.0.1:8080/                                            # 期望 200 ok
curl 'http://127.0.0.1:8080/dial?host=example.com&port=80'          # 看 dial 报告
# WebSocket：用任意 WS 客户端连 ws://127.0.0.1:8080/ws，发文本帧，看是否回显
# （本地曾用 Node 内置 WebSocket 客户端测过，见下）
```

## 本地验证（2026-11-07）

原生 Node v24.22.1（`PORT=8080 node server.js`）：

- `GET /` → 200 `ok` ✓
- `GET /ws` → 101，文本帧 `hello-probe` 原样回显，二进制帧 `[1,2,3]` 原样回显 ✓
- `GET /dial?host=example.com&port=80` → 200，报告 `dial: ok`，但**本地结果不可作数**：本机出口经代理拦截，DNS 把任意域名都解析到 198.18.213.x，读回的是代理提示文本而非目标站响应。代码路径（解析→连接→发请求→读回→报告）已验证通，但“能否任意出站 TCP”必须以 Wasmer Edge 上的实测为准。
- `GET /nope` → 404；`GET /ws`（不带升级头）→ 400；`port=99999` → 400；`host=bad_host!` → 400 ✓

Edge.js 运行时本地验证（`wasmer run --net --env PORT=8081 .`，用的就是
Anybuild 生成的包，见下）：

- `GET /` → 200 `ok` ✓
- `GET /ws` → 101，文本与二进制回显均通过 ✓
- `GET /dial` → 代码路径通，本地同样受出口代理干扰，以 Edge 实测为准。

## Anybuild 预检（2026-11-07，Anybuild 0.33.2，本地实测）

部署前已在本地跑过 Anybuild，确认 GitHub 导入能识别这个项目——这正是
Rust 版失败的地方：

- `anybuild plan .` → `Detected Node.js provider / Server: Node.js / Package manager: npm / Node version: 24`，命令为 `install: npm install`、`build: npm run build`、`start: node server.js`。
- `anybuild plan . --wasmer` → 同样识别为 node provider，且 Wasmer 侧配置含 `edgejs_enable: true`、`edgejs_precompile: true`，即 Wasmer 运行时用 **Edge.js** 承载这个 Node 应用。
- `anybuild build . --wasmer` → 构建成功（1.42 秒），生成的 `.anybuild/wasmer/wasmer.toml` 显示依赖为 `wasmer/edgejs-quickjs = "=0.2.5"`（QuickJS 版 Edge.js）和 `wasmer/bash`，入口命令为 `start`，以 `--bytecode-cache server.js` 运行，工作目录 `/app`。
- 生成的 `Anybuild` 文件已留在仓库根目录：它把 provider、启动命令、Node 版本写死，导入时 Anybuild 会直接采用，不再重新猜测。

注意：`.anybuild/` 是本地构建产物目录，**不要**传到 GitHub（已在 `.gitignore` 里排除）。

## 部署到 Wasmer Edge（由主 agent 另起浏览器任务做，本仓库不执行）

1. 在 GitHub 新建公开仓库 `liangshuanggit/wasmer-probe-node`（空仓库，不要勾选初始化 README）。
2. 把仓库根目录的文件传上去：`package.json`、`server.js`、`app.yaml`、`Anybuild`、`README.md`、`.gitignore`。不要传 `.anybuild/`。
3. 打开 https://wasmer.io/new，选 Import from GitHub，导入 `liangshuanggit/wasmer-probe-node`，应用名用 `wasmer-probe-node`，部署到 Edge。
4. 部署后从外部验证：

```sh
curl https://<app>.wasmer.app/                                   # 期望 200 ok
curl 'https://<app>.wasmer.app/dial?host=example.com&port=80'     # 看 dial 是否 ok、首行是否为真实 HTTP 响应
# WebSocket：用任意 WS 客户端连 wss://<app>.wasmer.app/ws，发送文本帧，看是否回显
```

判定：
- `/` 通 + `/ws` 回显通 + `/dial` 拿到 example.com 真实首行 → 网关转发 WS 且允许出站 TCP，可继续写 Node 版 VLESS 服务（Edge.js + node:http/node:net）。
- `/ws` 握手失败/掉线 → 网关不转发 WebSocket，改走 XHTTP packet-up 路线评估。
- `/dial` 连不上/被拒 → Edge 不允许任意出站 TCP，Wasmer 无法做通用代理节点，停下。

## 文件

- `package.json` — name `wasmer-probe-node`，main `server.js`，`start: node server.js`，`build: node --check server.js`（供 Anybuild 的 node provider 识别：package.json + build/start 命令），零依赖。
- `server.js` — 探针源码（只用 Node 内置 http、net、crypto、dns），无 npm 依赖。
- `app.yaml` — `kind: wasmer.io/App.v0`，`name: wasmer-probe-node`，`package: .`（本地构建时 Anybuild 已确认采用这份 app.yaml）。
- `Anybuild` — Anybuild 0.33.2 本地生成的定义文件，写死 node provider 与启动命令，导入时直接采用。
- `.gitignore` — 排除 `.anybuild/`、`node_modules/`。
- `README.md` — 本文件。

## 文档依据与未证实项

已证实（有来源）：
- Anybuild 的 Node.js provider 靠 `package.json` + build/start 命令识别项目（Anybuild 官方介绍：Node.js provider will look for a `package.json` and a build/start command；本地 `anybuild plan` 实测已识别）。
- Wasmer 运行时用 Edge.js 承载 Node 应用：本地 `anybuild plan . --wasmer` 输出 `edgejs_enable: true`；本地构建生成的 wasmer.toml 依赖 `wasmer/edgejs-quickjs = "=0.2.5"`；Wasmer 注册表把 `wasmer/edgejs` 列为“JavaScript / Node.js-compatible apps”的包。
- JS Worker（WinterCG fetch 事件）是另一条旧路线，不适用于本探针：本探针是普通 Node HTTP 服务，走 node provider + Edge.js，不是 js-worker 模板。
- app.yaml 格式 `kind: wasmer.io/App.v0` + `package: .` 与 Rust 版探针一致，本地构建已确认被采用。

未证实（正是探针要验证的）：
- Edge 网关是否把 WebSocket 升级转发给 Edge.js 应用。
- Edge 是否允许应用出站 TCP 直连任意地址（`net.connect`）。
- 生成的包里没有注入 `PORT` 环境变量，服务默认监听 80；Edge Proxy 模式的默认端口也是 80（调研报告第 3 节），两者一致，但 Edge 上实际生效的端口以部署后实测为准。
- 本地构建用的是 edgejs-quickjs（QuickJS 引擎）；Wasmer 官方博客说的完整 Node v24 兼容指的是 Edge.js 整体，QuickJS 版的 Node API 覆盖范围是否与 V8 版一致，未单独证实——探针在本地 edgejs-quickjs 下已跑通三个端点，Edge 上以实测为准。
