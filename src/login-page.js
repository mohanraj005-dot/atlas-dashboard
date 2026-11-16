// src/login-page.js
// The view gate's login page — hand-written HTML and CSS in exactly the idiom
// of public/index.html: the same design tokens, the same four type sizes and
// two weights, the same 4px spacing scale, both palettes driven only by
// prefers-color-scheme with no toggle, one 560px breakpoint. No framework, no
// build step, no dependency, no client-side script at all — the form is a
// plain POST, so the gate works with JavaScript disabled.
//
// It is served FROM THE WORKER rather than from public/ on purpose. Every
// static asset is gated; a login page living in public/ would need its own
// hole punched in the gate, and holes in a gate are how gates fail.

/**
 * Escapes text destined for the HTML body. The only interpolation on this
 * page is the error message, which is chosen from a fixed set below — this is
 * belt-and-braces so a future caller cannot turn it into an injection point.
 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * loginPage(message) — full HTML document. `message` is an optional error
 * line rendered above the form; omit it for the first visit.
 */
export function loginPage(message) {
  const error = message
    ? `<p class="text-body form-error" role="alert">${escapeHtml(message)}</p>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Atlas</title>
<style>
  /* ---- Design tokens: identical to public/index.html (both palettes, no toggle) ---- */
  :root {
    --color-bg: #FFFFFF;
    --color-surface: #F4F5F7;
    --color-border: #E2E4E8;
    --color-text: #16181D;
    --color-text-muted: #6B7280;
    --color-accent: #B45309;
    --color-destructive: #DC2626;
    --color-fill-strong: #16181D;
    --color-text-on-fill: #FFFFFF;
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --color-bg: #0B0D10;
      --color-surface: #16191D;
      --color-border: #2A2E35;
      --color-text: #E7E9EC;
      --color-text-muted: #9AA0AA;
      --color-accent: #F59E0B;
      --color-destructive: #F87171;
      --color-fill-strong: #E7E9EC;
      --color-text-on-fill: #0B0D10;
    }
  }

  * { box-sizing: border-box; }

  html, body {
    margin: 0;
    padding: 0;
    background: var(--color-bg);
    color: var(--color-text);
  }

  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 16px;
    font-weight: 400;
    line-height: 1.5;
  }

  /* ---- Typography: the same 4 sizes (16/13/20/28) and 2 weights (400/600) ---- */
  .text-display { font-size: 28px; font-weight: 600; line-height: 1.2; margin: 0; }
  .text-label {
    font-size: 13px;
    font-weight: 600;
    line-height: 1.2;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin: 0;
  }
  .text-body { font-size: 16px; font-weight: 400; line-height: 1.5; margin: 0; }
  .text-muted { color: var(--color-text-muted); }

  .page {
    padding: 48px 24px;
    display: flex;
    justify-content: center;
  }

  .login-card {
    width: 100%;
    max-width: 400px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    padding: 32px;
  }

  .login-title { margin-bottom: 8px; }

  .login-intro { margin-bottom: 24px; }

  .form-error {
    color: var(--color-destructive);
    margin-bottom: 16px;
  }

  .field-label {
    display: block;
    margin-bottom: 8px;
  }

  .field-input {
    width: 100%;
    font-family: inherit;
    font-size: 16px;
    font-weight: 400;
    line-height: 1.5;
    padding: 8px;
    margin-bottom: 16px;
    color: var(--color-text);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 4px;
  }

  .field-input:focus {
    outline: 2px solid var(--color-accent);
    outline-offset: 1px;
  }

  .submit-button {
    width: 100%;
    font-family: inherit;
    font-size: 16px;
    font-weight: 600;
    line-height: 1.5;
    padding: 8px 16px;
    color: var(--color-text-on-fill);
    background: var(--color-fill-strong);
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }

  .login-footnote {
    margin-top: 24px;
  }

  /* ---- Mobile: the same single breakpoint; stack, never break ---- */
  @media (max-width: 560px) {
    .page { padding: 24px 16px; }
    .login-card { padding: 24px; }
  }
</style>
</head>
<body>
  <div class="page">
    <main class="login-card">
      <h1 class="text-display login-title">Atlas</h1>
      <p class="text-body text-muted login-intro">This dashboard is private.</p>

      ${error}

      <form method="post" action="/login">
        <label class="text-label field-label" for="password">PASSWORD</label>
        <input
          class="field-input"
          id="password"
          name="password"
          type="password"
          autocomplete="current-password"
          autofocus
          required
        />
        <button class="submit-button" type="submit">Sign in</button>
      </form>

      <p class="text-label text-muted login-footnote">
        The collector keeps pushing on its own schedule — signing in only affects what you can see.
      </p>
    </main>
  </div>
</body>
</html>
`;
}
