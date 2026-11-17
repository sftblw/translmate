import { parseTranslatedInlineMarkdown, PlaceholderValidationError } from "../extraction/inlinePlaceholders";

export type DomPatchSpan = {
  placeholderId: string;
  node: Text;
  originalText: string;
};

export type DomPatchUnit = {
  unitId: string;
  spans: DomPatchSpan[];
  block?: Element;
};

export class DomPatchSession {
  private activeJobId: string | null = null;
  private units = new Map<string, DomPatchUnit>();
  private originals = new Map<Text, string>();

  startJob(jobId: string, units: DomPatchUnit[]) {
    if (this.activeJobId === jobId) {
      this.units = new Map(units.map((unit) => [unit.unitId, unit]));
      this.captureOriginals(units);
      return;
    }
    this.revert();
    this.activeJobId = jobId;
    this.units = new Map(units.map((unit) => [unit.unitId, unit]));
    this.originals.clear();
    this.captureOriginals(units);
  }

  private captureOriginals(units: DomPatchUnit[]) {
    for (const unit of units) {
      for (const span of unit.spans) {
        if (!this.originals.has(span.node)) {
          this.originals.set(span.node, span.originalText);
        }
      }
    }
  }

  applyUnitMarkdown(
    jobId: string,
    unitId: string,
    markdown: string,
    write: (span: DomPatchSpan, translated: string) => void = (span, translated) => {
      span.node.nodeValue = translated;
    },
  ): boolean {
    if (jobId !== this.activeJobId) {
      return false;
    }
    const unit = this.units.get(unitId);
    if (!unit) {
      return false;
    }

    const parsed = parseTranslatedInlineMarkdown(
      markdown,
      unit.spans.map((span) => span.placeholderId),
    );
    const translatedById = new Map(parsed.map((span) => [span.id, span.text]));

    for (const span of unit.spans) {
      const translated = translatedById.get(span.placeholderId);
      if (translated === undefined) {
        throw new PlaceholderValidationError(`Missing translated span ${span.placeholderId}`);
      }
      write(span, translated);
    }
    return true;
  }

  revert() {
    for (const [node, original] of this.originals) {
      node.nodeValue = original;
    }
  }

  clear() {
    this.revert();
    this.finish();
  }

  finish() {
    this.activeJobId = null;
    this.units.clear();
    this.originals.clear();
  }
}
