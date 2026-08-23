# clash-rules

跨平台共享 Clash 规则集：**Windows（Clash Verge/Verge Rev）· macOS（Clash Verge Rev）· OpenWrt（OpenClash）· iOS（Shadowrocket）**

规则来源：个人 Clash Verge 规则（`rules:` 段），按策略组拆分，剔除平台不兼容项后共享。

## 目录结构

```
clash-rules/
├── rules/                     # 共享规则集（.list 纯文本，不含策略）
│   ├── netflix.list           # 🎥 Netflix（33 条）
│   ├── llm.list               # 🤖 大模型（12 条，openai/chatgpt/gemini 等）
│   ├── direct.list            # 🎯 Direct（266 条）
│   ├── microsoft.list         # Ⓜ️ Microsoft（79 条，直连 🎯 Direct）
│   ├── apple.list             # 🍎 Apple（29 条）
│   ├── telegram.list          # 📲 Telegram（13 条）
│   ├── bilibili.list          # 📺 BiliBili（37 条）
│   ├── media.list             # 🌍 主流媒体（132 条）
│   ├── tiktok.list            # 🎵 tiktok（1 条，DOMAIN-KEYWORD）
│   ├── block.list             # 🛑 Block（412 条）
│   └── process.list           # ⚠️ PROCESS-NAME×16，仅 Windows/macOS 使用
├── base/
│   ├── mihomo-rule-providers.yaml   # Verge Rev / OpenClash 引用模板
│   └── verge-merge.yaml             # Clash Verge Rev merge 配置
└── README.md
```

## 规则集统计（修正版）

| 规则集 | 数量 | 兼容性 |
|---|---|---|
| netflix / llm / direct / microsoft / apple / telegram / bilibili / media / tiktok / block | 1030 | ✅ 全平台（DOMAIN/SUFFIX/KEYWORD/IP-CIDR/DST-PORT） |
| process.list | 16 | ⚠️ 仅 Clash 桌面端（PROCESS-NAME 路由器/手机不适用） |

**基础规则**（各端配置里直接写，不进规则集）：
```yaml
- GEOIP,CN,🎯 Direct
- GEOSITE,CN,🎯 Direct      # Shadowrocket 端删除此行（不支持 GEOSITE）
- MATCH,🐟 漏网之鱼
```

**规则优先级**：规则集引用顺序保持与原文件一致（否则匹配结果会变）：
`netflix → llm → direct → microsoft → apple → telegram → bilibili → media → tiktok → block → GEOIP,CN → GEOSITE,CN → MATCH`

## 各端接入

### 1) Clash Verge / Verge Rev（Windows / macOS）

- 在订阅上启用 **Merge 配置**，内容见 [`base/verge-merge.yaml`](base/verge-merge.yaml)（含 rule-providers + rules 引用）；
- `process.list` 额外引用（`RULE-SET,process,🎯 Direct`）——桌面端独有；
- 需在订阅配置中定义同名策略组：🛑 Block、🎯 Direct、🌍 主流媒体、Ⓜ️ Microsoft、📺 BiliBili、🎥 Netflix、🤖 大模型、🍎 Apple、📲 Telegram、🎵 tiktok、🐟 漏网之鱼。

### 2) OpenClash（OpenWrt 软路由）

- 覆写 → 自定义规则，内容同 `mihomo-rule-providers.yaml` 的 `rule-providers` + `rules`；
- **不引用 process.list**（路由器无进程概念）；
- 策略组在 OpenClash 的"覆写 → 自定义策略组"里按同名定义。

### 3) Shadowrocket（iOS）

- 设置 → 规则 → **添加规则集**，逐个填入以下 URL（raw 链接，替换为你的仓库地址）：
  ```
  https://raw.githubusercontent.com/archzhjam/clash-rules/main/rules/netflix.list
  https://raw.githubusercontent.com/archzhjam/clash-rules/main/rules/llm.list
  https://raw.githubusercontent.com/archzhjam/clash-rules/main/rules/direct.list
  https://raw.githubusercontent.com/archzhjam/clash-rules/main/rules/microsoft.list
  https://raw.githubusercontent.com/archzhjam/clash-rules/main/rules/apple.list
  https://raw.githubusercontent.com/archzhjam/clash-rules/main/rules/telegram.list
  https://raw.githubusercontent.com/archzhjam/clash-rules/main/rules/bilibili.list
  https://raw.githubusercontent.com/archzhjam/clash-rules/main/rules/media.list
  https://raw.githubusercontent.com/archzhjam/clash-rules/main/rules/tiktok.list
  https://raw.githubusercontent.com/archzhjam/clash-rules/main/rules/block.list
  ```
- **不添加 process.list**；基础规则里的 GEOSITE 行删除（用 GEOIP,CN 即可）；
- 每个规则集指定对应策略（Block→🛑 Block 等），Shadowrocket 的规则集支持按顺序匹配。

## 更新机制

- 规则集更新后，各端自动拉取：Verge Rev（规则集默认每天更新）、OpenClash（规则集缓存 + 定时）、Shadowrocket（规则集间隔更新）；
- 国内访问 raw.githubusercontent.com 可能慢/被墙 → 建议用 **jsDelivr CDN** 前缀：
  `https://cdn.jsdelivr.net/gh/archzhjam/clash-rules@main/rules/xxx.list`
  或在 GitHub 仓库开启 Actions 自动发布到 Releases。

## 维护

- 修改规则：编辑 `rules/*.list` 后提交推送即可，各端自动同步；
- 重新从 Verge 导出规则时：按策略拆分（注意 Windows 导出文件是 CRLF，先转 LF）+ 剔除 PROCESS-NAME/GEOSITE 的跨端差异处理。
