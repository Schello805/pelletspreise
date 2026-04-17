export async function apiFetch(path, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 0);
  const controller = timeoutMs ? new AbortController() : null;
  let timer = null;
  if (controller) timer = window.setTimeout(() => controller.abort(), timeoutMs);

  const { timeoutMs: _timeoutMs, ...rest } = options;

  const res = await fetch(path, {
    headers: { "content-type": "application/json", ...(rest.headers || {}) },
    signal: controller?.signal,
    ...rest,
  }).finally(() => {
    if (timer) window.clearTimeout(timer);
  });

  const isJson = (res.headers.get("content-type") || "").includes("application/json");
  const body = isJson ? await res.json().catch(() => null) : await res.text().catch(() => "");
  if (!res.ok) {
    const msg = body?.error || body?.message || res.statusText || "Request failed";
    const err = new Error(msg);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

