# 订阅生成器（deploy/generator）

机场订阅（节点）+ clash-rules 规则库（内联规则）→ 生成各端配置，跑在 NAS 局域网容器。

## 架构

```
NAS 容器（clash-subgen）
├── generate.mjs：拉机场节点 + 拉规则库 → clash.yaml / shadowrocket.conf
├── 内置 HTTP 服务 :8080 → 局域网客户端直接拉取
└── 定时(默认6h)重新生成 + git push → 私有仓库 clash-configs（公司手动访问）
```

## 部署（群晖 Container Manager）

1. 把本目录拷到 NAS（含 `config.json`，机场地址已填好）；
2. 准备 **私有仓库** `archzhjam/clash-configs`（空仓库，用于接收生成配置）；
3. 把 NAS 的 SSH 私钥挂载进容器（`docker-compose.yml` 里 `/volume1/homes/.../.ssh:/root/.ssh:ro`，按你的实际路径改）——用能推送 GitHub 的那把；
4. Container Manager → 项目 → 新建 → 选择本目录的 `docker-compose.yml` → 启动；
5. 验证：
   - 局域网：浏览器开 `http://<NAS_IP>:8080/clash.yaml`
   - 私有仓库：`git@github.com:archzhjam/clash-configs.git` 里有生成文件

## 各端订阅地址

| 端 | 地址 |
|---|---|
| Verge Rev / OpenClash（局域网） | `http://<NAS_IP>:8080/clash.yaml` |
| Shadowrocket（局域网） | `http://<NAS_IP>:8080/shadowrocket.conf` |
| 公司/远程（手动） | 登录 GitHub 私有仓库 `clash-configs` 复制最新文件 |

## 配置项（config.json，已 gitignore 不入库）

```json
{
  "airportUrl": "机场订阅地址（私密）",
  "rulesRepo": "archzhjam/clash-rules",
  "branch": "main",
  "outputDir": "./output",
  "listenPort": 8080,
  "pushRepo": "git@github.com:archzhjam/clash-configs.git",
  "pushBranch": "main"
}
```

## 本地测试（无需容器）

```bash
node generate.mjs            # 生成到 ./output
node generate.mjs --serve    # 生成 + 启动 :8080
```

## 安全说明

- `config.json`（机场地址）在 `.gitignore` 里，**不进入任何仓库**；
- 生成的 `clash.yaml` / `shadowrocket.conf`（含节点凭据）只推**私有**仓库；
- `clash-rules` 公开仓库只含规则，无任何凭据。

## 更新规则

直接改 `clash-rules` 仓库的 `rules/*.list` 并推送 → 下次生成自动拉取新规则 → 各端更新订阅即生效。
