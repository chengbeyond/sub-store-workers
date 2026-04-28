/**
 * Sub-Store Workers Panel - Enhanced
 * 
 * Surge Panel 脚本：监控 Cloudflare Workers/Pages 用量 + Sub-Store 业务状态
 * 
 * Arguments: accountId,token,limit,subStoreUrl
 *   - accountId: Cloudflare Account ID
 *   - token: Cloudflare API Token (需要 Analytics 读取权限)
 *   - limit: 每日请求额度，默认 100000
 *   - subStoreUrl: Sub-Store 后端地址（可选，如 https://example.com/your-path）
 *   - lang: 语言，cn 或 en（默认 en）
 */

const i18n = {
  en: {
    title: "Sub-Store Workers",
    reqs: "Reqs",
    err: "Err",
    subs: "Subs",
    remaining: "Left",
  },
  cn: {
    title: "Sub-Store Workers",
    reqs: "\u8BF7\u6C42",
    err: "\u9519\u8BEF",
    subs: "\u8BA2\u9605",
    remaining: "\u5269\u4F59",
  },
};

class CloudflareAPI {
  base_url = "https://api.cloudflare.com";

  constructor(accountId, token) {
    this.accountId = accountId;
    this.token = token;
  }

  async graphql(query, variables) {
    const r = await new Promise((resolve, reject) =>
      $httpClient.post(
        {
          url: `${this.base_url}/client/v4/graphql`,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.token}`,
          },
          body: JSON.stringify({ query, variables }),
        },
        (e, r, d) => (e ? reject(e) : resolve(d))
      )
    );
    const { data, errors } = JSON.parse(r);
    if (errors?.length) throw errors[0]?.message || "GraphQL error";
    return data;
  }

  async getUsage() {
    const now = new Date();
    const endDate = now.toISOString();
    now.setUTCHours(0, 0, 0, 0);
    const startDate = now.toISOString();
    const today = startDate.slice(0, 10);

    const filter = { datetime_geq: startDate, datetime_leq: endDate };

    const data = await this.graphql(
      `query ($accountId: string!, $filter: AccountWorkersInvocationsAdaptiveFilter_InputObject, $kvStart: Date, $kvEnd: Date) {
        viewer {
          accounts(filter: { accountTag: $accountId }) {
            workersInvocationsAdaptive(limit: 10000, filter: $filter) {
              sum {
                requests
                errors
                wallTime
              }
            }
            pagesFunctionsInvocationsAdaptiveGroups(limit: 1000, filter: $filter) {
              sum {
                requests
              }
            }
            kvOperationsAdaptiveGroups(limit: 1000, filter: { date_geq: $kvStart, date_leq: $kvEnd }) {
              sum {
                requests
              }
              dimensions {
                actionType
              }
            }
          }
        }
      }`,
      { accountId: this.accountId, filter, kvStart: today, kvEnd: today }
    );

    const account = data?.viewer?.accounts?.[0];

    // Workers
    const workersArr = account?.workersInvocationsAdaptive || [];
    const workers = workersArr.reduce((a, b) => a + (b?.sum?.requests || 0), 0);
    const workerErrors = workersArr.reduce((a, b) => a + (b?.sum?.errors || 0), 0);
    const cpuTimeMs = workersArr.reduce((a, b) => a + (b?.sum?.wallTime || 0), 0);

    // Pages
    const pagesArr = account?.pagesFunctionsInvocationsAdaptiveGroups || [];
    const pages = pagesArr.reduce((a, b) => a + (b?.sum?.requests || 0), 0);

    // KV
    const kvArr = account?.kvOperationsAdaptiveGroups || [];
    let kvReads = 0, kvWrites = 0;
    for (const item of kvArr) {
      const action = item?.dimensions?.actionType;
      const count = item?.sum?.requests || 0;
      if (action === "read") kvReads += count;
      else if (action === "write") kvWrites += count;
    }

    return { workers, pages, workerErrors, cpuTimeMs, kvReads, kvWrites };
  }
}

async function getSubStoreInfo(subStoreUrl) {
  if (!subStoreUrl) return null;
  try {
    const url = subStoreUrl.replace(/\/$/, "");
    const r = await new Promise((resolve, reject) =>
      $httpClient.get(
        { url: `${url}/api/utils/env`, headers: { "User-Agent": "SubStorePanel/1.0" } },
        (e, r, d) => (e ? reject(e) : resolve(d))
      )
    );
    const env = JSON.parse(r)?.data;

    // 获取订阅数量
    const r2 = await new Promise((resolve, reject) =>
      $httpClient.get(
        { url: `${url}/api/subs`, headers: { "User-Agent": "SubStorePanel/1.0" } },
        (e, r, d) => (e ? reject(e) : resolve(d))
      )
    );
    const subs = JSON.parse(r2)?.data;

    return {
      backend: env?.backend || "unknown",
      version: env?.version || "unknown",
      subCount: Array.isArray(subs) ? subs.length : "?",
    };
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

function formatNum(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}

const result = { title: "Sub-Store Workers", content: "", icon: "cloud.fill", "icon-color": "#F48120" };

(async () => {
  const args = $argument.split(",").map((s) => s.trim());
  const [accountId, token, limit = "100000", subStoreUrl, lang = "en"] = args;
  const t = i18n[lang] || i18n.en;
  result.title = t.title;

  const api = new CloudflareAPI(accountId, token);
  const usage = await api.getUsage();

  const total = usage.workers + usage.pages;
  const remaining = Number(limit) - total;
  const pct = ((total / Number(limit)) * 100).toFixed(1);

  let lines = [];
  lines.push(`${t.reqs}: ${formatNum(total)}/${formatNum(Number(limit))} (${pct}%)`);
  lines.push(`W: ${formatNum(usage.workers)}  P: ${formatNum(usage.pages)}  ${t.err}: ${usage.workerErrors}`);
  lines.push(`KV R/W: ${formatNum(usage.kvReads)}/${formatNum(usage.kvWrites)}`);

  if (subStoreUrl) {
    const info = await getSubStoreInfo(subStoreUrl);
    if (info && !info.error) {
      lines.push(`${t.subs}: ${info.subCount} | ${info.backend} ${info.version}`);
    } else if (info?.error) {
      lines.push(`Sub-Store: ${info.error}`);
    }
  }

  result.content = lines.join("\n");
})()
  .catch((e) => (result.content = `Error: ${e?.message || e}`))
  .finally(() => $done(result));
