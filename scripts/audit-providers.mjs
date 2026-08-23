#!/usr/bin/env node
// providers.json 免费模型目录审计（由 .github/workflows/audit-providers.yml 定时调度）。
//
// 职责：拉取各供应商实时模型目录，按免费判据过滤后自动刷新 providers.json 的
// models 数组，并产出 audit.json（含与上一期的 added/removed diff），供 ToadPack
// 客户端做「标注式同步」（下架只标注不删除）。
//
// 判据来源：
//   - 英伟达 / 谷歌 Gemini / OpenRouter / 硅基流动：移植自 FreeModelFinder 核心层
//     （github.com/orange90/FreeModelFinder，packages/core/src/providers/*.ts）
//   - Groq：平台不按模型计费（免费 tier 限速），判据 = 目录全收录，排除音频/嵌入/内容安全类
//   - 火山引擎：免费/试用模型无目录标志，判据 = 固定白名单 × 实时目录交集
//   - deepseek：官方无免费层，静态清单（目录不审计）
//
// 防误报（FreeModelFinder 同款稳健性设计）：
//   目录接口失败 / 空响应 / 零匹配时，该供应商标记 status=error 并**沿用上一期清单**，
//   绝不静默输出空清单（避免一次上游抽风被误判为「全部下架」）。
//   未配置密钥的供应商标记 status=skipped，同样沿用上一期清单。
//
// 依赖：Node 22+（原生 fetch），零 npm 依赖。

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const PROVIDERS_PATH = join(REPO_ROOT, 'providers.json');
const AUDIT_PATH = join(REPO_ROOT, 'audit.json');

// ---------------------------------------------------------------------------
// 供应商元数据与免费判据
// ---------------------------------------------------------------------------

// 英伟达：审核过的免费开发端点清单（移植 FreeModelFinder nvidia.ts FREE_MODEL_IDS）。
const NVIDIA_FREE_MODEL_IDS = new Set([
  'abacusai/dracarys-llama-3.1-70b-instruct',
  'bytedance/seed-oss-36b-instruct',
  'deepseek-ai/deepseek-v4-flash',
  'google/diffusiongemma-26b-a4b-it',
  'google/gemma-2-2b-it',
  'google/gemma-3n-e2b-it',
  'google/gemma-3n-e4b-it',
  'google/gemma-4-31b-it',
  'meta/llama-3.1-70b-instruct',
  'meta/llama-3.1-8b-instruct',
  'meta/llama-3.2-11b-vision-instruct',
  'meta/llama-3.2-1b-instruct',
  'meta/llama-3.2-3b-instruct',
  'meta/llama-3.2-90b-vision-instruct',
  'meta/llama-4-maverick-17b-128e-instruct',
  'minimaxai/minimax-m2.7',
  'minimaxai/minimax-m3',
  'mistralai/mistral-medium-3.5-128b',
  'mistralai/mistral-nemotron',
  'mistralai/mistral-small-4-119b-2603',
  'mistralai/mixtral-8x7b-instruct-v0.1',
  'nvidia/gliner-pii',
  'nvidia/ising-calibration-1-35b-a3b',
  'nvidia/ising-calibration-1.5-31b',
  'nvidia/llama-3.1-nemotron-nano-vl-8b-v1',
  'nvidia/llama-3.3-nemotron-super-49b-v1',
  'nvidia/llama-3.3-nemotron-super-49b-v1.5',
  'nvidia/nemotron-3-nano-30b-a3b',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
  'nvidia/nemotron-3-super-120b-a12b',
  'nvidia/nemotron-3-ultra-550b-a55b',
  'nvidia/nemotron-mini-4b-instruct',
  'nvidia/nemotron-nano-12b-v2-vl',
  'nvidia/nvidia-nemotron-nano-9b-v2',
  'nvidia/riva-translate-4b-instruct-v1.1',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'qwen/qwen3-next-80b-a3b-instruct',
  'sarvamai/sarvam-m',
  'stepfun-ai/step-3.5-flash',
  'stepfun-ai/step-3.7-flash',
  'upstage/solar-10.7b-instruct',
]);

// 谷歌 Gemini：账号 Free Tier 白名单（移植 FreeModelFinder gemini.ts GEMINI_FREE_ALLOW_LIST）。
const GEMINI_FREE_ALLOW_LIST = [
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemma-4-26b-a4b-it',
  'gemma-4-31b-it',
];
const GEMINI_FREE_ALLOW_MAP = new Map(
  GEMINI_FREE_ALLOW_LIST.map((id) => [id.toLowerCase(), id]),
);

// 硅基流动：平台免费型号白名单（移植 FreeModelFinder siliconflow.ts SF_FREE_ALLOW_LIST）。
const SF_FREE_ALLOW_LIST = [
  'Qwen/Qwen2.5-7B-Instruct',
  'Qwen/Qwen3-8B',
  'THUDM/GLM-4-9B-0414',
  'THUDM/GLM-Z1-9B-0414',
  'THUDM/GLM-4-Flash',
  'tencent/Hunyuan-MT-7B',
];
const SF_FREE_ALLOW_MAP = new Map(SF_FREE_ALLOW_LIST.map((id) => [id.toLowerCase(), id]));

// 火山引擎：免费/试用 doubao 型号白名单（无目录免费标志，人工审核维护）× 实时目录交集。
const VOLC_FREE_ALLOW_LIST = [
  'doubao-lite-1.6-flash-20250415',
  'doubao-pro-1.8-20250610',
  'doubao-seed-1.6-lite',
  'doubao-pro-code-1.5',
  'doubao-seedance-1.0-pro-fast',
  'doubao-seed-1.8-multimodal',
  'doubao-seed-character',
];

// deepseek：官方无免费层，静态清单（上下文窗口 1M，对齐上一期手工清单）。
const DEEPSEEK_STATIC_MODELS = [
  { id: 'deepseek-v4-flash', contextWindow: 1048576, maxTokens: 1048576 },
  { id: 'deepseek-v4-pro', contextWindow: 1048576, maxTokens: 1048576 },
];

// ---- 以下 6 个判据移植自 FreeModelFinder（github.com/orange90/FreeModelFinder）----

// 智谱：官方免费 Flash 静态清单（移植 zhipu.ts ZHIPU_STATIC_MODELS）。
const ZHIPU_STATIC_MODELS = [
  { id: 'glm-4-flash', contextWindow: 128000 },
  { id: 'glm-4.7-flash', contextWindow: 200000 },
];

// 魔搭：账号免费额度白名单（移植 modelscope.ts MS_FREE_ALLOW_LIST）× 实时目录交集。
const MS_FREE_ALLOW_LIST = [
  { id: 'Qwen/Qwen3-235B-A22B-Instruct-2507', contextWindow: 262144 },
  { id: 'Qwen/Qwen3-235B-A22B-Thinking-2507', contextWindow: 262144 },
  { id: 'Qwen/Qwen3-Next-80B-A3B-Instruct', contextWindow: 262144 },
  { id: 'Qwen/Qwen3-Next-80B-A3B-Thinking', contextWindow: 262144 },
  { id: 'Qwen/Qwen3-Coder-480B-A35B-Instruct', contextWindow: 262144 },
  { id: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', contextWindow: 262144 },
  { id: 'Qwen/Qwen3-VL-235B-A22B-Instruct', contextWindow: 131072 },
  { id: 'Qwen/Qwen3-32B', contextWindow: 131072 },
  { id: 'deepseek-ai/DeepSeek-V3.1', contextWindow: 131072 },
  { id: 'deepseek-ai/DeepSeek-V3', contextWindow: 65536 },
  { id: 'deepseek-ai/DeepSeek-R1', contextWindow: 65536 },
  { id: 'ZhipuAI/GLM-4.6', contextWindow: 204800 },
  { id: 'ZhipuAI/GLM-4.5', contextWindow: 131072 },
  { id: 'moonshotai/Kimi-K2-Instruct', contextWindow: 131072 },
  { id: 'MiniMax/MiniMax-M2', contextWindow: 204800 },
  { id: 'stepfun-ai/step3', contextWindow: 65536 },
];
const MS_FREE_ALLOW_MAP = new Map(MS_FREE_ALLOW_LIST.map((m) => [m.id.toLowerCase(), m]));

// Cohere：Trial 与 Production Key 都明确免费的 north-mini-code-1-0（移植 cohere.ts）。
const COHERE_FREE_ALLOW_LIST = ['north-mini-code-1-0'];

// Hugging Face Router：canonical 大小写映射（移植 huggingface.ts HF_RECOMMENDED）。
const HF_RECOMMENDED_MAP = new Map(
  [
    'deepseek-ai/DeepSeek-V3-0324',
    'deepseek-ai/DeepSeek-R1-0528',
    'meta-llama/Llama-3.3-70B-Instruct',
    'Qwen/Qwen2.5-72B-Instruct',
    'Qwen/Qwen2.5-Coder-32B-Instruct',
    'zai-org/GLM-4.5',
    'moonshotai/Kimi-K2-Instruct',
    'google/gemma-3-27b-it',
    'MiniMaxAI/MiniMax-M1-80k',
  ].map((id) => [id.toLowerCase(), id]),
);

// 商汤 SenseNova：目录零价过滤，接口不可用时回退审核过的免费静态清单（移植 sensenova.ts）。
const SENSENOVA_STATIC_MODELS = [
  { id: 'sensenova-6.7-flash-lite', contextWindow: 262144 },
  { id: 'deepseek-v4-flash', contextWindow: 1048576 },
  { id: 'glm-5.2', contextWindow: 1048576 },
];

// OpenRouter：排除内容安全/嵌入/重排等非对话工具模型（移植 openrouter.ts）。
const OPENROUTER_UTILITY_RE =
  /(?:content[-_ ]?safety|moderation|guard|classifier|embedding|rerank)/i;

// Groq：排除音频/嵌入/重排类（其余模型免费 tier 均可调用，限速不限模型）。
const GROQ_UTILITY_RE = /(?:whisper|embedding|rerank|moderation)/i;

// ---------------------------------------------------------------------------
// 目录抓取（每个供应商一个 fetch 函数：实时目录 → 免费过滤 → 标准化模型条目）
// 标准化条目：{ id, displayName, contextWindow }；contextWindow 可为 null。
// ---------------------------------------------------------------------------

async function fetchNvidia(apiKey) {
  const res = await fetch('https://integrate.api.nvidia.com/v1/models', {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`nvidia list models failed: ${res.status}`);
  const data = await res.json();
  const raw = Array.isArray(data?.data) ? data.data : [];
  if (raw.length === 0) throw new Error('nvidia list models returned empty data');
  const models = raw
    .filter((m) => typeof m?.id === 'string' && NVIDIA_FREE_MODEL_IDS.has(m.id))
    .map((m) => ({ id: m.id, displayName: m.id, contextWindow: null }));
  if (models.length === 0) {
    throw new Error(
      `nvidia list models returned ${raw.length} entries but none matched the free endpoint list`,
    );
  }
  return models;
}

async function fetchGroq(apiKey) {
  const res = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`groq list models failed: ${res.status}`);
  const data = await res.json();
  const raw = Array.isArray(data?.data) ? data.data : [];
  if (raw.length === 0) throw new Error('groq list models returned empty data');
  return raw
    .filter(
      (m) =>
        typeof m?.id === 'string' &&
        m.id.trim().length > 0 &&
        !GROQ_UTILITY_RE.test(m.id),
    )
    .map((m) => ({ id: m.id, displayName: m.id, contextWindow: null }));
}

async function fetchGemini(apiKey) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
  );
  if (!res.ok) throw new Error(`gemini list models failed: ${res.status}`);
  const data = await res.json();
  const raw = Array.isArray(data?.models) ? data.models : [];
  if (raw.length === 0) throw new Error('gemini list models returned empty data');
  const models = [];
  for (const m of raw) {
    if (!m?.name) continue;
    if (!Array.isArray(m.supportedGenerationMethods) ||
        !m.supportedGenerationMethods.includes('generateContent')) continue;
    const rawId = m.name.replace(/^models\//, '');
    const canonical = GEMINI_FREE_ALLOW_MAP.get(rawId.toLowerCase());
    if (!canonical) continue;
    models.push({
      id: canonical,
      displayName: m.displayName ?? canonical,
      contextWindow: m.inputTokenLimit ?? null,
    });
  }
  if (models.length === 0) {
    throw new Error(
      `gemini list models returned ${raw.length} entries but none matched the free whitelist`,
    );
  }
  return models;
}

async function fetchOpenrouter(apiKey) {
  const res = await fetch('https://openrouter.ai/api/v1/models?output_modalities=text', {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`openrouter list models failed: ${res.status}`);
  const data = await res.json();
  const raw = Array.isArray(data?.data) ? data.data : [];
  if (raw.length === 0) throw new Error('openrouter list models returned empty data');
  const models = raw
    .filter((m) => {
      const p = Number(m?.pricing?.prompt ?? '0');
      const c = Number(m?.pricing?.completion ?? '0');
      const output = m?.architecture?.output_modalities ?? [];
      const isFreeVariant = m?.id === 'openrouter/free' || String(m?.id ?? '').endsWith(':free');
      return (
        isFreeVariant &&
        !OPENROUTER_UTILITY_RE.test(String(m?.id ?? '')) &&
        p === 0 &&
        c === 0 &&
        (output.length === 0 || (output.length === 1 && output[0] === 'text'))
      );
    })
    .map((m) => ({
      id: m.id,
      displayName: m.name ?? m.id,
      contextWindow: m.context_length ?? null,
    }));
  if (models.length === 0) {
    throw new Error(
      `openrouter list models returned ${raw.length} entries but none matched the free filter`,
    );
  }
  return models;
}

async function fetchSiliconflow(apiKey) {
  // 拉未过滤目录（sub_type=chat 过滤曾导致免费聊天模型间歇性丢失，
  // 见 FreeModelFinder siliconflow.ts 注释），白名单交集自行过滤。
  const res = await fetch('https://api.siliconflow.cn/v1/models', {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`siliconflow list models failed: ${res.status}`);
  const data = await res.json();
  const raw = Array.isArray(data?.data) ? data.data : [];
  if (raw.length === 0) throw new Error('siliconflow list models returned empty data');
  const matched = new Map();
  for (const m of raw) {
    if (typeof m?.id !== 'string') continue;
    const canonical = SF_FREE_ALLOW_MAP.get(m.id.toLowerCase());
    if (!canonical) continue;
    matched.set(canonical, {
      id: canonical,
      displayName: canonical,
      contextWindow: m.context_length ?? null,
    });
  }
  if (matched.size === 0) {
    throw new Error(
      `siliconflow list models returned ${raw.length} entries but none matched the free whitelist`,
    );
  }
  return [...matched.values()];
}

async function fetchVolcengine(apiKey) {
  const res = await fetch('https://ark.cn-beijing.volcengine.com/api/v3/models', {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`volcengine list models failed: ${res.status}`);
  const data = await res.json();
  const raw = Array.isArray(data?.data) ? data.data : [];
  if (raw.length === 0) throw new Error('volcengine list models returned empty data');
  const matched = new Map();
  for (const m of raw) {
    if (typeof m?.id !== 'string') continue;
    const canonical = VOLC_FREE_ALLOW_LIST.find((id) => id === m.id);
    if (!canonical) continue;
    matched.set(canonical, { id: canonical, displayName: canonical, contextWindow: null });
  }
  if (matched.size === 0) {
    throw new Error(
      `volcengine list models returned ${raw.length} entries but none matched the free whitelist`,
    );
  }
  return [...matched.values()];
}

// 智谱：官方免费 Flash 静态清单（无目录审计；与 deepseek 同款静态口径）。
async function fetchZhipu() {
  return ZHIPU_STATIC_MODELS.map((m) => ({
    id: m.id,
    displayName: m.id,
    contextWindow: m.contextWindow,
  }));
}

// 魔搭：白名单 × 实时目录交集（移植 modelscope.ts；零匹配抛错防误报）。
async function fetchModelscope(apiKey) {
  const res = await fetch('https://api-inference.modelscope.cn/v1/models', {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`modelscope list models failed: ${res.status}`);
  const data = await res.json();
  const raw = Array.isArray(data?.data) ? data.data : [];
  if (raw.length === 0) throw new Error('modelscope list models returned empty data');
  const matched = new Map();
  for (const m of raw) {
    if (typeof m?.id !== 'string') continue;
    const canonical = MS_FREE_ALLOW_MAP.get(m.id.toLowerCase());
    if (!canonical) continue;
    matched.set(canonical.id, {
      id: canonical.id,
      displayName: canonical.id,
      contextWindow: canonical.contextWindow,
    });
  }
  if (matched.size === 0) {
    throw new Error(
      `modelscope list models returned ${raw.length} entries but none matched the free whitelist`,
    );
  }
  return [...matched.values()];
}

// GitHub Models：已于 2026-08 官方退休（catalog 端点 410 retirement brownout），
// 用户拍板从审计中移除——不再收录，本地已导入的模型由客户端按「供应商整体下线」标注。

// Cohere：north-mini-code-1-0 白名单 × 目录交集（chat 端点；移植 cohere.ts）。
async function fetchCohere(apiKey) {
  const res = await fetch('https://api.cohere.com/v1/models?page_size=1000', {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`cohere list models failed: ${res.status}`);
  const data = await res.json();
  const raw = Array.isArray(data?.models) ? data.models : [];
  if (raw.length === 0) throw new Error('cohere list models returned empty data');
  const picked = [];
  for (const m of raw) {
    const rawId = m?.id ?? m?.name;
    if (typeof rawId !== 'string') continue;
    const endpoints = m?.endpoints ?? [];
    if (endpoints.length > 0 && !endpoints.includes('chat')) continue;
    if (!COHERE_FREE_ALLOW_LIST.includes(rawId.toLowerCase())) continue;
    picked.push({
      id: rawId.toLowerCase(),
      displayName: rawId,
      contextWindow: m.context_length ?? null,
    });
  }
  if (picked.length === 0) {
    throw new Error(`cohere list models returned ${raw.length} entries but none matched the free whitelist`);
  }
  return picked;
}

// Hugging Face Router：模型 providers[] 中存在免费后端（is_free 或价 0）才收录。
function hfIsFreeProvider(p) {
  if (p?.status && p.status !== 'live') return false;
  if (p?.is_free === true) return true;
  const inPrice = p?.pricing?.input;
  const outPrice = p?.pricing?.output;
  return typeof inPrice === 'number' && typeof outPrice === 'number' && inPrice === 0 && outPrice === 0;
}

async function fetchHuggingface(apiKey) {
  const res = await fetch('https://router.huggingface.co/v1/models', {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`huggingface list models failed: ${res.status}`);
  const data = await res.json();
  const raw = Array.isArray(data?.data) ? data.data : [];
  if (raw.length === 0) throw new Error('huggingface list models returned empty data');
  const seen = new Set();
  const models = [];
  for (const m of raw) {
    if (typeof m?.id !== 'string') continue;
    const providers = Array.isArray(m.providers) ? m.providers : [];
    const freeProviders = providers.filter(hfIsFreeProvider);
    if (freeProviders.length === 0) continue;
    const canonical = HF_RECOMMENDED_MAP.get(m.id.toLowerCase()) ?? m.id;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    const ctx =
      m.context_length ??
      freeProviders.map((p) => p.context_length).find((v) => typeof v === 'number');
    models.push({ id: canonical, displayName: canonical, contextWindow: ctx ?? null });
  }
  if (models.length === 0) {
    throw new Error(
      `huggingface list models returned ${raw.length} entries but none had a free backend`,
    );
  }
  return models;
}

// 商汤 SenseNova：目录零价过滤；接口不可用时回退审核过的免费静态清单（与上游同款，
// 静态清单是官方免费 tier，回退视作成功而非 error）。
async function fetchSensenova(apiKey) {
  try {
    const res = await fetch('https://token.sensenova.cn/v1/models', {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (res.ok) {
      const data = await res.json();
      const raw = Array.isArray(data?.data) ? data.data : [];
      const dynamic = raw
        .filter((m) => typeof m?.id === 'string' && m.id.length > 0)
        .filter((m) => {
          const outs = m.output_modalities;
          if (Array.isArray(outs) && !outs.includes('text')) return false;
          const prompt = Number(m.pricing?.prompt ?? Number.NaN);
          const completion = Number(m.pricing?.completion ?? Number.NaN);
          return prompt === 0 && completion === 0;
        })
        .map((m) => ({ id: m.id, displayName: m.id, contextWindow: null }));
      if (dynamic.length > 0) return dynamic;
    }
  } catch {
    // 回退静态清单
  }
  return SENSENOVA_STATIC_MODELS.map((m) => ({
    id: m.id,
    displayName: m.id,
    contextWindow: m.contextWindow,
  }));
}

// 审计键 → 抓取器（按 base_url 与上一期 providers.json 对齐，不依赖数组下标）。
// display/registerUrl 是新增供应商的首期元数据（中文名、注册链接），
// 上一期已存在时沿用上一期的 id/name/api_type/register_url。
const PROVIDER_META = [
  {
    key: 'nvidia',
    envKeys: ['NVIDIA_API_KEY'],
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    display: '英伟达',
    registerUrl: 'https://build.nvidia.com/explore/discover?modal=signin',
    fetch: fetchNvidia,
  },
  {
    key: 'groq',
    envKeys: ['GROQ_API_KEY'],
    baseUrl: 'https://api.groq.com/openai/v1',
    display: 'Groq',
    registerUrl: 'https://console.groq.com/',
    fetch: fetchGroq,
  },
  {
    key: 'gemini',
    envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    baseUrl: 'https://generativelanguage.googleapis.com/v1',
    display: '谷歌',
    registerUrl: 'https://aistudio.google.com/prompts/new_chat',
    fetch: fetchGemini,
  },
  {
    key: 'openrouter',
    envKeys: ['OPENROUTER_API_KEY'],
    baseUrl: 'https://openrouter.ai/api/v1',
    display: 'openrouter',
    registerUrl: 'https://openrouter.ai/',
    fetch: fetchOpenrouter,
  },
  {
    key: 'siliconflow',
    envKeys: ['SILICONFLOW_API_KEY'],
    baseUrl: 'https://api.siliconflow.cn/v1',
    display: '硅基流动',
    registerUrl: 'https://cloud.siliconflow.cn/',
    fetch: fetchSiliconflow,
  },
  {
    key: 'volcengine',
    envKeys: ['VOLCENGINE_API_KEY'],
    baseUrl: 'https://ark.cn-beijing.volcengine.com/api/v3',
    display: '火山引擎',
    registerUrl: 'https://console.volcengine.com/ark',
    fetch: fetchVolcengine,
  },
  {
    key: 'deepseek',
    envKeys: [],
    baseUrl: 'https://api.deepseek.com/anthropic',
    display: 'deepseek',
    registerUrl: 'https://chat.deepseek.com/sign_up',
    staticModels: DEEPSEEK_STATIC_MODELS,
  },
  // ---- 以下移植自 FreeModelFinder ----
  {
    key: 'zhipu',
    envKeys: [],
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    display: '智谱 AI',
    registerUrl: 'https://open.bigmodel.cn/',
    staticModels: ZHIPU_STATIC_MODELS,
  },
  {
    key: 'modelscope',
    envKeys: ['MODELSCOPE_API_KEY'],
    baseUrl: 'https://api-inference.modelscope.cn/v1',
    display: '魔搭',
    registerUrl: 'https://modelscope.cn/',
    fetch: fetchModelscope,
  },
  {
    key: 'cohere',
    envKeys: ['COHERE_API_KEY'],
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    display: 'Cohere',
    registerUrl: 'https://dashboard.cohere.com/welcome/register',
    fetch: fetchCohere,
  },
  {
    key: 'huggingface',
    envKeys: ['HUGGINGFACE_API_KEY'],
    baseUrl: 'https://router.huggingface.co/v1',
    display: 'Hugging Face',
    registerUrl: 'https://huggingface.co/join',
    fetch: fetchHuggingface,
  },
  {
    key: 'sensenova',
    envKeys: ['SENSENOVA_API_KEY'],
    baseUrl: 'https://token.sensenova.cn/v1',
    display: '商汤 SenseNova',
    registerUrl: 'https://platform.sensenova.cn/',
    fetch: fetchSensenova,
  },
];

/// 是否需要密钥：静态清单（deepseek/智谱）不需要。
function metaNeedsKey(meta) {
  if (meta.staticModels) return false;
  return true;
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function readEnvKey(candidates) {
  for (const name of candidates) {
    const raw = process.env[name];
    if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  }
  return null;
}

function todayIsoInShanghai() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date());
}

// 标准化模型条目 → providers.json 的 models 元素：
// 有上下文窗口用对象形态 {name, context_window[, max_tokens]}，否则纯字符串（向后兼容老客户端）。
// 注意：老客户端（ToadPack online_model_importer/first_run_wizard）解析对象形态时
// max_tokens 是 i64 + serde(default)——只容忍字段**缺失**，不容忍 null；
// register_url/id 字段缺失同样会解析失败。故此处绝不输出 null 值，字段缺失时输出空字符串。
function toJsonModel(m) {
  if (Number.isFinite(m.contextWindow) && m.contextWindow > 0) {
    const obj = { name: m.id, context_window: m.contextWindow };
    if (Number.isFinite(m.maxTokens) && m.maxTokens > 0) obj.max_tokens = m.maxTokens;
    return obj;
  }
  return m.id;
}

function modelIdsOf(entries) {
  if (!Array.isArray(entries)) return new Set();
  const ids = new Set();
  for (const e of entries) {
    if (typeof e === 'string') ids.add(e);
    else if (e && typeof e.name === 'string') ids.add(e.name);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  // 上一期 providers.json（error/skipped 供应商沿用其清单；保留手工元数据）。
  let previous;
  try {
    previous = JSON.parse(await readFile(PROVIDERS_PATH, 'utf8'));
  } catch (err) {
    console.error(`[audit] could not read previous providers.json: ${err.message}`);
    previous = null;
  }
  const previousByBaseUrl = new Map();
  if (Array.isArray(previous?.providers)) {
    for (const p of previous.providers) {
      if (p?.base_url) previousByBaseUrl.set(p.base_url, p);
    }
  }
  // 上一期 audit.json（用于 added/removed diff）。
  let previousAudit;
  try {
    previousAudit = JSON.parse(await readFile(AUDIT_PATH, 'utf8'));
  } catch {
    previousAudit = null;
  }

  const results = [];
  for (const meta of PROVIDER_META) {
    const prevProvider = previousByBaseUrl.get(meta.baseUrl) ?? null;
    const prevEntries = prevProvider?.models ?? [];

    // 静态清单（deepseek/智谱）：无需目录审计，恒 ok。
    if (meta.staticModels) {
      results.push({
        meta,
        status: 'ok',
        error: null,
        models: meta.staticModels.map((m) => ({
          id: m.id,
          displayName: m.id,
          contextWindow: m.contextWindow ?? null,
          maxTokens: m.maxTokens ?? null,
        })),
      });
      continue;
    }

    const apiKey = readEnvKey(meta.envKeys);
    if (metaNeedsKey(meta) && !apiKey) {
      // 未配置密钥：跳过，沿用上一期清单。
      results.push({
        meta,
        status: 'skipped',
        error: null,
        models: prevEntries
          .map((e) => {
            const id = typeof e === 'string' ? e : e?.name;
            if (typeof id !== 'string') return null;
            const cw = typeof e === 'object' ? e.context_window ?? null : null;
            return { id, displayName: id, contextWindow: cw };
          })
          .filter(Boolean),
      });
      console.error(`[audit] skipped ${meta.key}: no ${meta.envKeys.join('|')}`);
      continue;
    }

    try {
      const models = await meta.fetch(apiKey);
      results.push({
        meta,
        status: 'ok',
        error: null,
        models: models
          .filter((m) => m?.id && m.id.trim().length > 0)
          .sort((a, b) => a.id.localeCompare(b.id)),
      });
      console.error(`[audit] ${meta.key}: ok, ${models.length} free models`);
    } catch (err) {
      // 目录失败/空响应/零匹配：标记 error 并沿用上一期清单（防误报「全部下架」）。
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[audit] ${meta.key}: ERROR — ${msg}; preserving previous snapshot`);
      results.push({
        meta,
        status: 'error',
        error: msg,
        models: prevEntries
          .map((e) => {
            const id = typeof e === 'string' ? e : e?.name;
            if (typeof id !== 'string') return null;
            const cw = typeof e === 'object' ? e.context_window ?? null : null;
            return { id, displayName: id, contextWindow: cw };
          })
          .filter(Boolean),
      });
    }
  }

  // ---- 生成 providers.json（version 2.0.0：audited_at + 每供应商 status） ----
  const date = todayIsoInShanghai();
  const outProviders = [];
  for (const r of results) {
    const prevProvider = previousByBaseUrl.get(r.meta.baseUrl) ?? null;
    // 元数据：上一期已存在的沿用其 id/name/api_type/register_url；
    // 新增供应商用 PROVIDER_META 的 display/registerUrl 首期元数据。
    const provider = {
      id: prevProvider?.id ?? '',
      name: prevProvider?.name ?? r.meta.display,
      base_url: prevProvider?.base_url ?? r.meta.baseUrl,
      api_type: prevProvider?.api_type ?? 'openai',
      register_url: prevProvider?.register_url ?? r.meta.registerUrl ?? '',
      status: r.status,
      models: r.models.map(toJsonModel),
    };
    outProviders.push(provider);
  }
  const nextProviders = {
    version: '2.0.0',
    audited_at: date,
    providers: outProviders,
  };
  await writeFile(PROVIDERS_PATH, `${JSON.stringify(nextProviders, null, 2)}\n`, 'utf8');

  // ---- 生成 audit.json（含 added/removed diff） ----
  const changes = { comparedWith: null, added: [], removed: [] };
  if (previousAudit?.providers) {
    changes.comparedWith = previousAudit.date ?? null;
    const prevById = new Map(
      previousAudit.providers.map((p) => [p.id, modelIdsOf(p.models)]),
    );
    for (const r of results) {
      if (r.status !== 'ok') continue;
      const before = prevById.get(r.meta.key);
      if (!before) continue;
      const current = new Set(r.models.map((m) => m.id));
      for (const m of r.models) {
        if (!before.has(m.id)) changes.added.push({ provider: r.meta.key, id: m.id });
      }
      for (const id of before) {
        if (!current.has(id)) changes.removed.push({ provider: r.meta.key, id });
      }
    }
  }
  const audit = {
    schemaVersion: 1,
    date,
    generatedAt: new Date().toISOString(),
    totalModels: results.reduce((sum, r) => sum + r.models.length, 0),
    providers: results.map((r) => ({
      id: r.meta.key,
      status: r.status,
      count: r.models.length,
      error: r.error ?? null,
      models: r.models.map((m) => ({
        id: m.id,
        displayName: m.displayName ?? m.id,
        contextWindow: m.contextWindow ?? null,
      })),
    })),
    changes,
  };
  await writeFile(AUDIT_PATH, `${JSON.stringify(audit, null, 2)}\n`, 'utf8');

  const ok = results.filter((r) => r.status === 'ok').length;
  const added = changes.added.length;
  const removed = changes.removed.length;
  console.error(
    `[audit] done: ${ok}/${results.length} providers ok, ${audit.totalModels} models, ` +
      `+${added}/-${removed} vs ${changes.comparedWith ?? '(baseline)'}`,
  );
}

main().catch((err) => {
  console.error('[audit] fatal:', err);
  process.exit(1);
});
