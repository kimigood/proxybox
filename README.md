# ProxyBox

OpenWrt 一体化透明代理：一条命令装完 sing-box 内核 + 管理面板，浏览器打开即用。
无需手写配置文件：订阅、节点、策略分流、DNS 接管全部在面板里点出来。

> 状态：v0.1.0 骨架可用。后端核心（订阅解析 / 重命名 / 配置生成 / 部署流水线 / API）
> 已实现并通过冒烟测试；面板前端为 MIT 复用；仍需真机联调。

## 架构

```
路由器 /opt/proxybox/
├── bin/sing-box        内核（钦定版本 1.13.14，musl 静态）
├── node/               Node.js 运行时（安装时下载）
├── panel/dist          管理面板前端（构建产物）
├── server/             面板后端（Node.js，本项目全新编写）
├── etc/config.json     生成的 sing-box 配置（面板下发）
└── data/               SQLite、订阅缓存、规则集 .srs、日志

/etc/init.d/proxybox-core    sing-box 服务
/etc/init.d/proxybox-panel   面板服务
```

- **配置面**：面板后端以 root 运行，写 `etc/config.json`，调 init.d 启停。`sing-box check` 先行校验，失败拒绝下发。
- **运行态**：tun 入站 `auto_route` 接管流量；`experimental.clash_api` 只监听 `127.0.0.1:9095`，面板后端中转。
- **分流判定链**：私网直连 → 广告拒绝（可选）→ 类别规则集 → 直连规则集 → DNS 劫持 → 兜底。
- **DNS 双通道**：直连域名走直连 DNS，代理域名走代理 DNS（经代理节点出站），DNS 与连接永远同侧。

## 仓库结构

```
proxybox/
├── panel/        管理面板前端 —— 复用 MIT 代码（见下文"来源与许可"）
├── server/       后端（全新编写）
│   ├── index.mjs          入口：Express 应用、静态前端、API 挂载
│   ├── lib/
│   │   ├── auth.mjs       登录墙：scrypt 密码哈希 + 会话 cookie
│   │   ├── store.mjs      SQLite：profile / 订阅 / 用户组 / 部署状态
│   │   ├── subscribe.mjs  订阅解析：Clash YAML / 分享链接 / sing-box JSON
│   │   ├── rename.mjs     节点重命名引擎：地区归一 + 特征提取 + 命名模板
│   │   ├── config.mjs     sing-box 配置生成器（核心）
│   │   └── service.mjs    部署流水线 / 回滚 / 冲突检测 / 内核版本
│   └── api/               REST API（对齐面板前端的调用契约）
├── openwrt/initd/  服务脚本
└── scripts/        install.sh / build.sh
```

## 来源与许可

- `panel/` 前端 fork 自上游开源项目（zashboard，MIT License）。`panel/LICENSE` 与
  `panel/NOTICE.md` 必须保留、不得删除或改写；在此前提下允许修改与分发。
- `server/`、`scripts/`、`openwrt/` 为本项目全新编写。
- sing-box 内核与 GeoIP/GeoSite 数据遵循各自上游许可，随安装包分发。

## 本地开发

```bash
cd server && npm install
node smoke.mjs        # 冒烟测试：解析 -> 重命名 -> 生成配置 -> HTTP API
PROXYBOX_PORT=3037 node index.mjs
```

## 路线图

- [x] 订阅解析（Clash YAML / ss/vmess/vless/trojan/hysteria2/tuic/wireguard / sing-box JSON）
- [x] 重命名引擎 + 地区自动分组
- [x] sing-box 配置生成（tun / 出站 / 路由 / DNS 双通道 / clash_api），真二进制 `check` 校验通过
- [x] 登录认证、profile、订阅、分组、部署、服务、规则穿透 API
- [x] 部署流水线：冲突检测 → 规则集自动下载 → sing-box check → 下发 → 重启 → 校验
- [x] 紧急回滚（一键恢复直连，面板 API + LuCI 兜底页）
- [x] 规则集（.srs）下载与定时更新（7 天）、订阅定时更新（24 小时）
- [x] dnsmasq 接管模式联动、IPv6 泄漏防护（nftables）
- [x] clash_api 中转（HTTP + WebSocket，供面板运行态页面：连接/流量/日志）
- [x] 安装包：`scripts/build.sh` 打 tarball（含前端构建产物与生产依赖），`scripts/install.sh` 一键安装
- [ ] 真机联调：x86_64 / aarch64 OpenWrt 实测（tun 自动路由、dnsmasq 接管、LuCI 页）

## 安装

在 OpenWrt 路由器上（x86_64 / aarch64，root），一键安装：

```sh
curl -fsSL https://raw.githubusercontent.com/kimigood/proxybox/main/scripts/install.sh | sh
```

这条命令会：装依赖（kmod-tun、ca-bundle）→ 从 GitHub Releases 拉取最新安装包 →
解包到 /opt/proxybox → 下载 Node.js 与 sing-box 1.13.14 → 装服务脚本与 LuCI 兜底页 →
启动面板。之后浏览器打开 `http://<路由器IP>:3037`，首次设置密码，添加订阅，
点"部署"即完成。

手动安装（已下载 tarball）：

```sh
sh install.sh /tmp/proxybox-0.1.0.tar.gz
```

## 安全提示

面板后端拥有路由器 root 权限。面板端口默认只监听局域网，**不要把端口转发到公网**；
需要在外网访问时，请套一层带认证的 HTTPS 反向代理，或先用 VPN 接入局域网。
