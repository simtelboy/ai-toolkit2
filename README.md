# AIClient Guardian 更新仓库

ToadPack（aiclient-guardian-rust）的在线模型目录仓库：`providers.json` 是免费模型供应商清单，
由 ToadPack 首次运行向导与「软件设置 → 通用设置 → 添加模型」读取。

## providers.json 自动审计

`.github/workflows/audit-providers.yml` 每 72 小时（及手动触发）运行 `scripts/audit-providers.mjs`，
拉取各供应商实时模型目录并按免费判据过滤，自动刷新 `providers.json` 的 `models` 数组，
同时产出 `audit.json`（含与上一期的新增/移除 diff），供 ToadPack 做「下架只标注不删除」的同步。

**免费判据**（覆盖 FreeModelFinder 全部 10 个 Provider + 自维护 3 个）：
- 英伟达 / 谷歌 Gemini / OpenRouter / 硅基流动 / 魔搭 / Cohere / Hugging Face / 商汤 SenseNova：
  移植自 [FreeModelFinder](https://github.com/orange90/FreeModelFinder) 核心层
- 智谱：官方免费 Flash 静态清单（GLM-4-Flash / GLM-4.7-Flash）
- GitHub Models：公开目录全收录（文本输出，原型开发额度；目录无需 token）
- Groq：平台不按模型计费（免费 tier 限速），目录全收录（排除音频/嵌入类）
- 火山引擎：免费/试用 doubao 型号白名单 × 实时目录交集
- deepseek：静态清单（官方无免费层）

**防误报**：目录接口失败/空响应/零匹配时，该供应商标记 `status=error` 并沿用上一期清单；
未配置密钥的供应商标记 `status=skipped` 同样沿用。

## 首次接入

1. 在仓库 Settings → Secrets and variables → Actions 配置供应商 API 密钥
   （按需，未配置的自动跳过）：`NVIDIA_API_KEY`、`GROQ_API_KEY`、`GEMINI_API_KEY`、
   `OPENROUTER_API_KEY`、`SILICONFLOW_API_KEY`、`VOLCENGINE_API_KEY`、
   `MODELSCOPE_API_KEY`、`COHERE_API_KEY`、`HUGGINGFACE_API_KEY`、`SENSENOVA_API_KEY`、
   `GITHUB_MODELS_TOKEN`（可选，目录公开）
2. Actions → Providers audit → Run workflow 手动触发一次，完成 providers.json v2 迁移与审计基线

> 注：providers.json 的 `models` 由审计自动维护，请勿手工编辑（可通过扩展白名单常量维护判据）。
> 推送 main 分支会经 sync-to-gitee.yml 自动镜像到 Gitee。
