import { TranslationSession } from "../content/TranslationSession";
import "../content/highlight.css";

export default defineContentScript({
  matches: ["*://*/*"],
  main() {
    let session: TranslationSession | undefined;

    const startSession = () => {
      session = new TranslationSession(document);
      session.startDomObserver();
    };
    startSession();

    const messageListener = (
      msg: unknown,
      sender: globalThis.Browser.runtime.MessageSender,
      sendResponse: ((response?: unknown) => void) | undefined,
    ) => {
      return session?.handleRuntimeMessage(msg, sender, sendResponse);
    };

    browser.runtime.onMessage.addListener(messageListener);

    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted && !session) startSession();
    };

    const onPageHide = (event: PageTransitionEvent) => {
      session?.cleanup({ cancelBackground: false });
      session = undefined;
      if (!event.persisted) {
        browser.runtime.onMessage.removeListener(messageListener);
        window.removeEventListener("pagehide", onPageHide);
        window.removeEventListener("pageshow", onPageShow);
      }
    };

    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
  },
});
