/** Tiny DOM helpers — no framework, no ceremony. */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Partial<Record<string, string | number | boolean>> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "className") node.className = String(v);
    else if (k === "textContent") node.textContent = String(v);
    else node.setAttribute(k, String(v));
  }
  for (const c of children) node.append(c);
  return node;
}

export interface SliderOpts {
  min: number;
  max: number;
  step: number;
  value: number;
  format?: (v: number) => string;
  badge?: "morph" | "struct";
  title?: string;
  onInput: (v: number) => void;
  onCommit?: (v: number) => void;
}

export function sliderRow(label: string, opts: SliderOpts): HTMLElement {
  const out = el("output", { textContent: opts.format ? opts.format(opts.value) : String(opts.value) });
  const input = el("input", {
    type: "range",
    min: opts.min,
    max: opts.max,
    step: opts.step,
    value: opts.value,
  });
  if (opts.title) input.title = opts.title;
  input.addEventListener("input", () => {
    const v = Number(input.value);
    out.textContent = opts.format ? opts.format(v) : String(v);
    opts.onInput(v);
  });
  input.addEventListener("change", () => {
    opts.onCommit?.(Number(input.value));
  });
  const labelEl = el("label", { textContent: label });
  if (opts.badge) {
    labelEl.append(
      el("span", {
        className: `badge ${opts.badge}`,
        textContent: opts.badge === "morph" ? "morph" : "struct",
      }),
    );
  }
  return el("div", { className: "ctl" }, [labelEl, out, input]);
}

/** Section open/closed state persists across sidebar rebuilds. */
const sectionOpenState = new Map<string, boolean>();

export function section(title: string, body: HTMLElement[], open = true): HTMLElement {
  const isOpen = sectionOpenState.get(title) ?? open;
  const chev = el("span", { className: "chev", textContent: isOpen ? "−" : "+" });
  const head = el("button", { className: "section-head" }, [title, " ", chev]);
  const bodyEl = el("div", { className: "section-body" }, body);
  const sec = el("div", { className: `section${isOpen ? "" : " collapsed"}` }, [head, bodyEl]);
  head.addEventListener("click", () => {
    sec.classList.toggle("collapsed");
    const nowOpen = !sec.classList.contains("collapsed");
    sectionOpenState.set(title, nowOpen);
    chev.textContent = nowOpen ? "−" : "+";
  });
  return sec;
}

export function fmt(v: number, digits = 1): string {
  return v.toFixed(digits);
}

export function fmtTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}
