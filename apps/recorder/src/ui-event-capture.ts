import type { Page } from "playwright";

export interface CapturedUIEvent {
  id: string;
  timestamp: number;
  type: "click" | "input" | "change" | "submit" | "focus" | "blur" | "scroll" | "keydown";
  selector: string;
  tagName: string;
  attributes: Record<string, string>;
  value?: string; // For input/change events
  text?: string; // For click events (button text, link text)
  position?: { x: number; y: number }; // For click events
  key?: string; // For keydown events
}

export interface UIEventCaptureCallbacks {
  onEvent: (event: CapturedUIEvent) => void;
}

// Script to inject into the page for event capture
const CAPTURE_SCRIPT = `
(function() {
  if (window.__k6flowEventCapture) return;
  window.__k6flowEventCapture = true;

  let eventId = 0;

  function generateSelector(el) {
    if (!el || el === document.body) return 'body';
    
    // Try ID first
    if (el.id) {
      return '#' + CSS.escape(el.id);
    }
    
    // Try data-testid or similar
    const testId = el.getAttribute('data-testid') || 
                   el.getAttribute('data-test') || 
                   el.getAttribute('data-cy');
    if (testId) {
      return '[data-testid="' + testId + '"]';
    }
    
    // Try name attribute for form elements
    if (el.name && ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(el.tagName)) {
      const nameSelector = el.tagName.toLowerCase() + '[name="' + el.name + '"]';
      if (document.querySelectorAll(nameSelector).length === 1) {
        return nameSelector;
      }
    }
    
    // Try role + accessible name
    const role = el.getAttribute('role');
    const ariaLabel = el.getAttribute('aria-label');
    if (role && ariaLabel) {
      return '[role="' + role + '"][aria-label="' + ariaLabel + '"]';
    }
    
    // Build path with nth-child
    const parent = el.parentElement;
    if (!parent) return el.tagName.toLowerCase();
    
    const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
    const index = siblings.indexOf(el);
    const nthChild = siblings.length > 1 ? ':nth-of-type(' + (index + 1) + ')' : '';
    
    return generateSelector(parent) + ' > ' + el.tagName.toLowerCase() + nthChild;
  }

  function getAttributes(el) {
    const attrs = {};
    const important = ['type', 'name', 'placeholder', 'href', 'role', 'aria-label', 'class'];
    for (const name of important) {
      const val = el.getAttribute(name);
      if (val) attrs[name] = val;
    }
    return attrs;
  }

  function sendEvent(type, el, extra = {}) {
    const event = {
      id: 'ui-' + (++eventId),
      timestamp: Date.now(),
      type: type,
      selector: generateSelector(el),
      tagName: el.tagName.toLowerCase(),
      attributes: getAttributes(el),
      ...extra
    };
    window.__k6flowEventCallback?.(event);
  }

  // Click events
  document.addEventListener('click', (e) => {
    const el = e.target;
    sendEvent('click', el, {
      text: el.innerText?.slice(0, 100),
      position: { x: e.clientX, y: e.clientY }
    });
  }, true);

  // Input events (debounced)
  let inputTimeout = null;
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (inputTimeout) clearTimeout(inputTimeout);
    inputTimeout = setTimeout(() => {
      sendEvent('input', el, {
        value: el.type === 'password' ? '***' : el.value?.slice(0, 500)
      });
    }, 300);
  }, true);

  // Change events (for selects, checkboxes)
  document.addEventListener('change', (e) => {
    const el = e.target;
    let value = el.value;
    if (el.type === 'checkbox' || el.type === 'radio') {
      value = el.checked ? 'checked' : 'unchecked';
    }
    sendEvent('change', el, { value });
  }, true);

  // Form submit
  document.addEventListener('submit', (e) => {
    sendEvent('submit', e.target);
  }, true);

  // Focus/blur for form analytics
  document.addEventListener('focus', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) {
      sendEvent('focus', e.target);
    }
  }, true);

  // Scroll (throttled)
  let scrollTimeout = null;
  document.addEventListener('scroll', (e) => {
    if (scrollTimeout) return;
    scrollTimeout = setTimeout(() => {
      scrollTimeout = null;
      sendEvent('scroll', document.documentElement, {
        position: { x: window.scrollX, y: window.scrollY }
      });
    }, 500);
  }, true);

  // Important key events (Enter, Tab, Escape)
  document.addEventListener('keydown', (e) => {
    if (['Enter', 'Tab', 'Escape'].includes(e.key)) {
      sendEvent('keydown', e.target, { key: e.key });
    }
  }, true);
})();
`;

/**
 * UIEventCapture injects a script to capture user interactions.
 */
export class UIEventCapture {
  private page: Page | null = null;
  private callbacks: UIEventCaptureCallbacks;
  private enabled = false;
  private paused = false;

  constructor(callbacks: UIEventCaptureCallbacks) {
    this.callbacks = callbacks;
  }

  async start(page: Page): Promise<void> {
    this.page = page;

    // Expose callback function
    await page.exposeFunction("__k6flowEventCallback", (event: CapturedUIEvent) => {
      if (!this.paused) {
        this.callbacks.onEvent(event);
      }
    });

    // Inject capture script
    await page.addInitScript(CAPTURE_SCRIPT);
    
    // Also run on current page
    await page.evaluate(CAPTURE_SCRIPT);

    this.enabled = true;
  }

  async stop(): Promise<void> {
    this.page = null;
    this.enabled = false;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  get isPaused(): boolean {
    return this.paused;
  }
}
