import "../background/zodCsp";
import { PageAgentManager } from "../background/pageAgent/PageAgentManager";

export default defineBackground(() => {
  const manager = new PageAgentManager();
  const onMessage = (
    message: unknown,
    sender: globalThis.Browser.runtime.MessageSender,
    respond: (response?: unknown) => void,
  ) => manager.handleRuntimeMessage(message, sender, respond) === true;
  const onRemoved = (tabId: number) => manager.handleTabRemoved(tabId);
  const onCommitted = (details: { tabId: number; frameId: number }) => {
    if (details.frameId === 0) manager.handleTabDocumentChanged(details.tabId);
  };

  browser.runtime.onMessage.addListener(onMessage);
  browser.tabs.onRemoved.addListener(onRemoved);
  browser.webNavigation.onCommitted.addListener(onCommitted);

  return () => {
    browser.runtime.onMessage.removeListener(onMessage);
    browser.tabs.onRemoved.removeListener(onRemoved);
    browser.webNavigation.onCommitted.removeListener(onCommitted);
  };
});
