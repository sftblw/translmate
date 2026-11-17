const selectableContainerSelector = [
  "p",
  "li",
  "blockquote",
  "figcaption",
  "td",
  "th",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "article",
  "main",
  "[role='main']",
  "section",
  "div",
].join(",");

const unsafeSelector = [
  "script",
  "style",
  "template",
  "noscript",
  "svg",
  "canvas",
  "nav",
  "header",
  "footer",
  "aside",
  "menu",
  "dialog",
  "form",
  "input",
  "textarea",
  "select",
  "button",
  "[contenteditable='true']",
  "[role='navigation']",
  "[role='banner']",
  "[role='contentinfo']",
  "[role='toolbar']",
  "[role='menu']",
  "[data-translmate-ui='true']",
].join(",");

export class TranslationAreaInspector {
  private active = false;
  private hovered: Element | undefined;
  private finishSelection: ((element?: Element) => void) | undefined;
  private instruction: HTMLDivElement | undefined;

  constructor(private readonly document: Document) {}

  start() {
    if (this.active) {
      return Promise.reject(new Error("area-selection-already-active"));
    }
    this.active = true;
    this.instruction = this.document.createElement("div");
    this.instruction.className = "translmate-area-instruction";
    this.instruction.dataset.translmateUi = "true";
    this.instruction.setAttribute("role", "status");
    this.instruction.textContent = "Click the page area to translate · Esc to cancel";
    this.document.body?.append(this.instruction);
    this.document.addEventListener("pointermove", this.handlePointerMove, true);
    this.document.addEventListener("click", this.handleClick, true);
    this.document.addEventListener("keydown", this.handleKeyDown, true);

    return new Promise<Element | undefined>((resolve) => {
      this.finishSelection = resolve;
    });
  }

  cancel() {
    this.finish(undefined);
  }

  private handlePointerMove = (event: Event) => {
    const candidate = selectionCandidate(event.target);
    if (candidate === this.hovered) {
      return;
    }
    this.hovered?.classList.remove("translmate-area-candidate");
    this.hovered = candidate;
    this.hovered?.classList.add("translmate-area-candidate");
  };

  private handleClick = (event: Event) => {
    if (!this.active) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const candidate = selectionCandidate(event.target);
    if (!candidate) {
      if (this.instruction) {
        this.instruction.textContent = "Choose a text area inside the page · Esc to cancel";
      }
      return;
    }
    this.finish(candidate);
  };

  private handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.finish(undefined);
  };

  private finish(element?: Element) {
    if (!this.active) return;
    this.active = false;
    this.document.removeEventListener("pointermove", this.handlePointerMove, true);
    this.document.removeEventListener("click", this.handleClick, true);
    this.document.removeEventListener("keydown", this.handleKeyDown, true);
    this.hovered?.classList.remove("translmate-area-candidate");
    this.hovered = undefined;
    this.instruction?.remove();
    this.instruction = undefined;
    const resolve = this.finishSelection;
    this.finishSelection = undefined;
    resolve?.(element);
  }
}

function selectionCandidate(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return undefined;
  }
  if (target.closest("[data-translmate-ui='true']")) {
    return undefined;
  }
  const candidate = target.closest(selectableContainerSelector);
  if (!candidate || candidate.matches(unsafeSelector) || candidate.closest(unsafeSelector)) {
    return undefined;
  }
  const text = candidate.textContent?.replace(/\s+/g, " ").trim() ?? "";
  return /\p{L}/u.test(text) ? candidate : undefined;
}
