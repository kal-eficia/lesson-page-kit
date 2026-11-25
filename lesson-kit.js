/*! lesson-page-kit v1.0.0 · MIT · github.com/kal-eficia/lesson-page-kit
 *
 * Turns a lesson written as JSON into a calm, multi-page student page:
 *   - multiple choice with instant feedback and an optional confidence check
 *   - sort tasks, written answers (never self-marked)
 *   - a copyable summary at the end of every page, so the teacher sees the work
 *   - correct-answer positions planned so the key has no guessable pattern
 *   - an optional endpoint so answers can stream to a live class dashboard
 */
(function () {
  "use strict";

  const LETTERS = "ABCDEFGH";
  const CONF = ["Guessing", "Think so", "Certain"];

  // ---------------------------------------------------------------- utils
  const $ = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  };
  // **bold** and *italic* only; everything else is plain text (no HTML injection).
  const rich = (text) => {
    const frag = document.createDocumentFragment();
    String(text || "").split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).forEach((part) => {
      if (/^\*\*.+\*\*$/.test(part)) frag.append($("strong", {}, part.slice(2, -2)));
      else if (/^\*.+\*$/.test(part)) frag.append($("em", {}, part.slice(1, -1)));
      else if (part) frag.append(part);
    });
    return frag;
  };
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  const rng = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const hash = (s) => [...s].reduce((h, c) => (Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0), 2166136261);
  const shuffle = (arr, r) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };

  // ------------------------------------------- pattern-free answer key
  function badTail(k, strict) {
    const n = k.length;
    if (n >= 2 && k[n - 1] === k[n - 2] && (strict || (n >= 3 && k[n - 3] === k[n - 1]))) return true;
    if (n >= 3) { const a = k[n - 1] - k[n - 2], b = k[n - 2] - k[n - 3]; if (a === b && Math.abs(a) === 1) return true; }
    if (n >= 4 && k[n - 1] === k[n - 3] && k[n - 2] === k[n - 4] && k[n - 1] !== k[n - 2]) return true;
    for (let p = 3; p <= 5; p++) if (n >= 2 * p && k.slice(-p).join() === k.slice(-2 * p, -p).join()) return true;
    return false;
  }
  function planKey(length, options, r, strict = true) {
    for (let attempt = 0; attempt < 300; attempt++) {
      const bag = shuffle(Array.from({ length }, (_, i) => i % options), r);
      const key = [];
      let budget = 3000;
      const place = (rest) => {
        if (!rest.length) return true;
        if (--budget <= 0) return false;
        const tried = new Set();
        for (const i of shuffle([...rest.keys()], r)) {
          const v = rest[i];
          if (tried.has(v)) continue;
          tried.add(v);
          key.push(v);
          if (!badTail(key, strict) && place(rest.filter((_, j) => j !== i))) return true;
          key.pop();
        }
        return false;
      };
      if (place(bag)) return key;
    }
    return Array.from({ length }, () => Math.floor(r() * options));
  }

  // ---------------------------------------------------------------- engine
  class Lesson {
    constructor(root, lesson) {
      this.root = root;
      this.lesson = lesson;
      this.key = "lk:" + (lesson.id || hash(lesson.title));
      this.state = store.get(this.key) || { name: "", page: 0, answers: {} };
      this.endpoint = root.dataset.endpoint || lesson.endpoint || null;
      this.prepare();
      this.state.name ? this.renderPage() : this.renderJoin();
    }

    save() { store.set(this.key, this.state); }

    // Reorder options so the lesson's correct-answer positions form no pattern.
    prepare() {
      const r = rng(hash(this.lesson.title + (this.lesson.seed || "")));
      const mcqs = this.lesson.pages.flatMap((p) => p.blocks.filter((b) => b.type === "mcq"));
      const width = Math.min(...mcqs.map((b) => b.options.length), 8);
      const plan = mcqs.length ? planKey(mcqs.length, width, r) : [];
      mcqs.forEach((b, i) => {
        const correct = b.options[b.answer];
        const rest = shuffle(b.options.filter((_, j) => j !== b.answer), r);
        rest.splice(plan[i], 0, correct);
        b._options = rest;
        b._answer = plan[i];
      });
      for (const p of this.lesson.pages) for (const b of p.blocks) {
        if (b.type !== "sort") continue;
        // no bucket three times running; prefer no back-to-back repeats
        let best = null, bestScore = 1e9;
        for (let t = 0; t < 200 && bestScore > 0; t++) {
          const order = shuffle([...b.items], r);
          const ks = order.map((it) => b.buckets.indexOf(it.bucket));
          let score = 0, bad = false;
          for (let i = 1; i < ks.length; i++) { if (ks[i] === ks[i - 1]) score++; if (i > 1 && ks[i] === ks[i - 1] && ks[i] === ks[i - 2]) bad = true; }
          if (!bad && score < bestScore) { best = order; bestScore = score; }
        }
        b._items = best || b.items;
      }
    }

    emit(block, entry) {
      const detail = { lesson: this.lesson.title, page: this.state.page + 1, student: this.state.name, id: block.id, ...entry, at: new Date().toISOString() };
      window.dispatchEvent(new CustomEvent("lesson:answer", { detail }));
      if (this.endpoint) fetch(this.endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(detail), keepalive: true }).catch(() => {});
    }

    toast(msg) {
      let t = document.querySelector(".lk-toast");
      if (!t) document.body.append((t = $("div", { class: "lk-toast", role: "status", "aria-live": "polite" })));
      t.textContent = msg;
      t.classList.add("show");
      clearTimeout(this._t);
      this._t = setTimeout(() => t.classList.remove("show"), 1800);
    }

    // ------------------------------------------------------------ screens
    renderJoin() {
      const input = $("input", { type: "text", placeholder: "Your first name", autocomplete: "given-name", maxlength: 30, "aria-label": "Your first name" });
      const go = () => {
        const name = input.value.trim().replace(/\s+/g, " ");
        if (!name) return input.focus();
        this.state.name = name;
        this.save();
        this.renderPage();
      };
      input.addEventListener("keydown", (e) => e.key === "Enter" && go());
      this.root.replaceChildren($("main", { class: "lk-shell" },
        $("div", { class: "lk-join" },
          $("p", { class: "lk-kicker" }, this.lesson.subject || "Lesson"),
          $("h1", { class: "lk-title" }, this.lesson.title),
          $("p", { class: "lk-intro" }, this.lesson.intro || "Work through each page. Your answers are saved as you go."),
          input,
          $("button", { class: "lk-btn", onclick: go }, "Start the lesson →"))));
      input.focus();
    }

    renderPage() {
      const { pages } = this.lesson;
      const idx = Math.min(this.state.page, pages.length - 1);
      const page = pages[idx];
      let n = 0;
      const blocks = page.blocks.map((b) => this.block(b, b.type === "text" || b.type === "note" ? null : ++n));
      const summary = this.summaryCard(page, idx);
      const prev = $("button", { class: "lk-btn ghost", "aria-disabled": String(idx === 0), onclick: () => this.go(idx - 1) }, "← Back");
      const last = idx === pages.length - 1;
      const next = $("button", { class: "lk-btn" + (last ? " gold" : ""), onclick: () => (last ? this.finish() : this.go(idx + 1)) }, last ? "Finish" : "Next page →");
      this.root.replaceChildren($("main", { class: "lk-shell" },
        $("header", { class: "lk-top" }, $("span", { class: "lk-brand" }, this.lesson.subject || "Lesson"), $("span", { class: "lk-name" }, this.state.name)),
        $("div", { class: "lk-progress", "aria-label": `Page ${idx + 1} of ${pages.length}` }, pages.map((_, i) => $("span", { class: i < idx ? "done" : i === idx ? "here" : "" }))),
        $("p", { class: "lk-kicker" }, page.kicker || `Page ${idx + 1}`),
        $("h1", { class: "lk-title" }, page.title),
        page.intro ? $("p", { class: "lk-intro" }, rich(page.intro)) : null,
        blocks, summary, $("nav", { class: "lk-nav" }, prev, next)));
      window.scrollTo({ top: 0 });
    }

    go(i) { this.state.page = Math.max(0, i); this.save(); this.renderPage(); }

    finish() {
      this.root.replaceChildren($("main", { class: "lk-shell" }, $("div", { class: "lk-join" },
        $("p", { class: "lk-kicker" }, "Done"),
        $("h1", { class: "lk-title" }, `Well done, ${this.state.name}.`),
        $("p", { class: "lk-intro" }, this.lesson.outro || "Make sure you've pasted every page summary. See you next lesson."),
        $("button", { class: "lk-btn ghost", onclick: () => this.go(0) }, "Look back through the lesson"))));
    }

    // ------------------------------------------------------------ blocks
    block(b, n) {
      const head = (text) => $("h3", {}, n ? $("span", { class: "lk-num", "aria-hidden": "true" }, n) : null, rich(text));
      if (b.type === "text") return $("section", { class: "lk-block" }, b.heading ? head(b.heading) : null, (Array.isArray(b.body) ? b.body : [b.body]).map((p) => $("p", {}, rich(p))));
      if (b.type === "note") return $("section", { class: "lk-block lk-note" }, $("p", {}, rich(b.body)));
      if (b.type === "mcq") return this.mcq(b, head);
      if (b.type === "sort") return this.sort(b, head);
      if (b.type === "write") return this.write(b, head);
      return $("section", { class: "lk-block" }, `Unknown block type: ${b.type}`);
    }

    mcq(b, head) {
      const saved = this.state.answers[b.id];
      const feedback = $("div", { class: "lk-feedback", "aria-live": "polite" });
      let confidence = saved?.confidence || null;
      const confRow = b.confidence ? $("div", { class: "lk-conf" }, "How sure are you?",
        CONF.map((c) => $("button", { class: "lk-chip", "aria-pressed": confidence === c, onclick: (e) => {
          if (this.state.answers[b.id]) return;
          confidence = c;
          confRow.querySelectorAll(".lk-chip").forEach((x) => x.setAttribute("aria-pressed", x === e.currentTarget));
        } }, c))) : null;
      const buttons = b._options.map((opt, i) => $("button", { class: "lk-opt", onclick: () => choose(i) },
        $("span", { class: "lk-letter" }, LETTERS[i]), $("span", {}, rich(opt))));
      const paint = (i) => {
        buttons.forEach((btn, j) => { btn.disabled = true; if (j === b._answer) btn.classList.add("right"); else if (j === i) btn.classList.add("wrong"); });
        const right = i === b._answer;
        feedback.replaceChildren($("b", {}, right ? "Yes. " : "Not quite. "), rich(b.why || (right ? "" : `The answer is ${LETTERS[b._answer]}.`)));
      };
      const choose = (i) => {
        if (this.state.answers[b.id]) return;
        if (b.confidence && !confidence) { this.toast("Pick how sure you are first"); return; }
        const right = i === b._answer;
        this.state.answers[b.id] = { type: "mcq", q: b.q, chose: b._options[i], result: right ? "right" : "wrong", confidence };
        this.save();
        paint(i);
        this.emit(b, this.state.answers[b.id]);
        this.refreshSummary();
      };
      if (saved) setTimeout(() => paint(b._options.indexOf(saved.chose)));
      return $("section", { class: "lk-block" }, head(b.q), confRow, $("div", { class: "lk-options", role: "group" }, buttons), feedback);
    }

    sort(b, head) {
      const saved = this.state.answers[b.id];
      const picks = saved ? { ...saved.picks } : {};
      const feedback = $("div", { class: "lk-feedback", "aria-live": "polite" });
      const rows = b._items.map((it) => {
        const row = $("div", { class: "lk-sort-row" }, $("span", {}, rich(it.text)),
          $("div", { class: "lk-buckets" }, b.buckets.map((bk) => $("button", { class: "lk-chip", "aria-pressed": picks[it.text] === bk, onclick: (e) => {
            if (this.state.answers[b.id]) return;
            picks[it.text] = bk;
            e.currentTarget.parentElement.querySelectorAll(".lk-chip").forEach((x) => x.setAttribute("aria-pressed", x === e.currentTarget));
          } }, bk))));
        row._item = it;
        return row;
      });
      const mark = () => rows.forEach((r) => r.classList.add(picks[r._item.text] === r._item.bucket ? "right" : "wrong"));
      const check = $("button", { class: "lk-btn", style: "margin-top:14px", onclick: () => {
        if (this.state.answers[b.id]) return;
        if (Object.keys(picks).length < b.items.length) { this.toast("Sort every item first"); return; }
        const score = b.items.filter((it) => picks[it.text] === it.bucket).length;
        this.state.answers[b.id] = { type: "sort", q: b.prompt, picks, score: `${score}/${b.items.length}` };
        this.save();
        mark();
        check.setAttribute("aria-disabled", "true");
        feedback.replaceChildren($("b", {}, `${score} of ${b.items.length} sorted correctly. `), rich(b.why || ""));
        this.emit(b, this.state.answers[b.id]);
        this.refreshSummary();
      } }, "Check my sort");
      if (saved) setTimeout(() => { mark(); check.setAttribute("aria-disabled", "true"); feedback.textContent = `${saved.score} sorted correctly.`; });
      return $("section", { class: "lk-block" }, head(b.prompt), $("div", { class: "lk-sort" }, rows), check, feedback);
    }

    write(b, head) {
      const saved = this.state.answers[b.id];
      const words = (s) => (s.trim().match(/\S+/g) || []).length;
      const count = $("div", { class: "lk-count" });
      const box = $("textarea", { class: "lk-text", placeholder: b.placeholder || "Write your answer here", "aria-label": b.prompt });
      box.value = saved?.text || "";
      const update = () => {
        const w = words(box.value);
        count.textContent = b.minWords ? `${w} / ${b.minWords} words` : `${w} words`;
      };
      let timer;
      box.addEventListener("input", () => {
        update();
        clearTimeout(timer);
        timer = setTimeout(() => {
          this.state.answers[b.id] = { type: "write", q: b.prompt, text: box.value.trim() };
          this.save();
          this.refreshSummary();
        }, 400);
      });
      box.addEventListener("blur", () => box.value.trim() && this.emit(b, { type: "write", q: b.prompt, text: box.value.trim() }));
      update();
      return $("section", { class: "lk-block" }, head(b.prompt), b.hint ? $("p", { style: "color:var(--ink-soft);font-size:15px" }, rich(b.hint)) : null, box, count);
    }

    // ------------------------------------------------------------ summary
    summaryText(page, idx) {
      const lines = [`${this.state.name} · ${this.lesson.title} · page ${idx + 1}: ${page.title}`];
      let n = 0;
      for (const b of page.blocks) {
        if (b.type === "text" || b.type === "note") continue;
        n++;
        const a = this.state.answers[b.id];
        if (!a) { lines.push(`Q${n}: (not answered)`); continue; }
        if (a.type === "mcq") lines.push(`Q${n}: ${a.result === "right" ? "✓" : "✗"} ${a.chose}${a.confidence ? ` (${a.confidence})` : ""}`);
        if (a.type === "sort") lines.push(`Q${n}: sort ${a.score}`);
        if (a.type === "write") lines.push(`Q${n}: ${a.text}`);
      }
      return lines.join("\n");
    }

    summaryCard(page, idx) {
      const pre = $("pre", {}, this.summaryText(page, idx));
      this._summary = { pre, page, idx };
      const copy = async () => {
        const text = this.summaryText(page, idx);
        try { await navigator.clipboard.writeText(text); }
        catch { const r = document.createRange(); r.selectNodeContents(pre); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.execCommand("copy"); }
        this.toast("Copied. Paste it in the chat for your teacher.");
      };
      return $("section", { class: "lk-summary" },
        $("h3", {}, "Your page summary"),
        $("p", {}, this.lesson.summaryHint || "Copy this and paste it in the class chat before you move on."),
        pre, $("button", { class: "lk-btn gold", onclick: copy }, "Copy my summary"));
    }

    refreshSummary() {
      if (this._summary) this._summary.pre.textContent = this.summaryText(this._summary.page, this._summary.idx);
    }
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    for (const root of document.querySelectorAll("[data-lesson]")) {
      let lesson;
      const inline = document.getElementById(root.dataset.lesson);
      if (inline) lesson = JSON.parse(inline.textContent);
      else lesson = await (await fetch(root.dataset.lesson)).json();
      root._lesson = new Lesson(root, lesson);
    }
  }
  window.LessonKit = { boot, planKey, version: "1.0.0" };
  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", boot) : boot();
})();
