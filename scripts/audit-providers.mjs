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
  { name: 'deepseek-v4-flash', context_window: 1048576, max_tokens: 1048576 },
  { name: 'deepseek-v4-pro', context_window: 1048576, max_tokens: 1048576 },
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

// 审计键 → 抓取器（按 base_url 与上一期 providers.json 对齐，不依赖数组下标）。
const PROVIDER_META = [
  {
    key: 'nvidia',
    envKeys: ['NVIDIA_API_KEY'],
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    fetch: fetchNvidia,
  },
  {
    key: 'groq',
    envKeys: ['GROQ_API_KEY'],
    baseUrl: 'https://api.groq.com/openai/v1',
    fetch: fetchGroq,
  },
  {
    key: 'gemini',
    envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    baseUrl: 'https://generativelanguage.googleapis.com/v1',
    fetch: fetchGemini,
  },
  {
    key: 'openrouter',
    envKeys: ['OPENROUTER_API_KEY'],
    baseUrl: 'https://openrouter.ai/api/v1',
    fetch: fetchOpenrouter,
  },
  {
    key: 'siliconflow',
    envKeys: ['SILICONFLOW_API_KEY'],
    baseUrl: 'https://api.siliconflow.cn/v1',
    fetch: fetchSiliconflow,
  },
  {
    key: 'volcengine',
    envKeys: ['VOLCENGINE_API_KEY'],
    baseUrl: 'https://ark.cn-beijing.volcengine.com/api/v3',
    fetch: fetchVolcengine,
  },
  {
    key: 'deepseek',
    envKeys: [], // 静态清单，无需密钥
    baseUrl: 'https://api.deepseek.com/anthropic',
    fetch: null,
  },
];

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

    // 静态清单（deepseek）：无需目录，恒 ok。
    if (!meta.fetch) {
      results.push({
        meta,
        status: 'ok',
        error: null,
        models: DEEPSEEK_STATIC_MODELS.map((m) => ({
          id: m.name,
          displayName: m.name,
          contextWindow: m.context_window,
          maxTokens: m.max_tokens,
        })),
      });
      continue;
    }

    const apiKey = readEnvKey(meta.envKeys);
    if (!apiKey) {
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
    // 元数据以审计结果为准，但保留上一期的 id/name/api_type/register_url。
    const provider = {
      id: prevProvider?.id ?? '',
      name: prevProvider?.name ?? r.meta.key,
      base_url: prevProvider?.base_url ?? r.meta.baseUrl,
      api_type: prevProvider?.api_type ?? 'openai',
      register_url: prevProvider?.register_url ?? '',
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
