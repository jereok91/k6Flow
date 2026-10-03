export interface Step {
  id: string;
  name: string;
  kind: "step" | "assert" | "note" | "auto";
  timestamp: number;
  note?: string;
  trigger?: string; // What triggered this step (manual, navigation, form, etc)
}

export interface StepManagerCallbacks {
  onStep: (step: Step) => void;
}

/**
 * StepManager handles manual and automatic step markers.
 */
export class StepManager {
  private steps: Step[] = [];
  private stepCounter = 0;
  private callbacks: StepManagerCallbacks;
  private lastNavUrl: string | null = null;
  private paused = false;

  constructor(callbacks: StepManagerCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Add a manual step marker.
   */
  addManualStep(name: string, kind: "step" | "assert" | "note", note?: string): Step {
    const step: Step = {
      id: `step-${++this.stepCounter}`,
      name,
      kind,
      timestamp: Date.now(),
      note,
      trigger: "manual",
    };
    this.steps.push(step);
    this.callbacks.onStep(step);
    return step;
  }

  /**
   * Add an auto-detected step based on navigation.
   */
  addNavigationStep(url: string, title: string): Step | null {
    if (this.paused) return null;
    
    // Skip if same URL
    if (url === this.lastNavUrl) return null;
    this.lastNavUrl = url;

    // Extract meaningful name from URL
    const urlObj = new URL(url);
    let name = urlObj.pathname;
    if (name === "/" || name === "") {
      name = urlObj.hostname;
    }
    name = name.replace(/^\//, "").replace(/\/$/, "") || "Home";
    
    // Shorten long paths
    if (name.length > 30) {
      const parts = name.split("/");
      name = parts[parts.length - 1] || parts[parts.length - 2] || name;
    }

    const step: Step = {
      id: `step-${++this.stepCounter}`,
      name: `Navigate: ${name}`,
      kind: "auto",
      timestamp: Date.now(),
      note: title || undefined,
      trigger: "navigation",
    };
    this.steps.push(step);
    this.callbacks.onStep(step);
    return step;
  }

  /**
   * Add an auto-detected step based on form submission.
   */
  addFormSubmitStep(formSelector: string): Step | null {
    if (this.paused) return null;

    // Extract form name or action
    let name = "Submit Form";
    if (formSelector.includes("login") || formSelector.includes("signin")) {
      name = "Login";
    } else if (formSelector.includes("register") || formSelector.includes("signup")) {
      name = "Register";
    } else if (formSelector.includes("search")) {
      name = "Search";
    } else if (formSelector.includes("checkout")) {
      name = "Checkout";
    }

    const step: Step = {
      id: `step-${++this.stepCounter}`,
      name,
      kind: "auto",
      timestamp: Date.now(),
      trigger: "form_submit",
    };
    this.steps.push(step);
    this.callbacks.onStep(step);
    return step;
  }

  /**
   * Add an auto-detected step based on significant click.
   */
  addClickStep(selector: string, text?: string): Step | null {
    if (this.paused) return null;

    // Only auto-step for significant clicks (buttons, links with meaningful text)
    const isSignificant = 
      selector.includes("button") ||
      selector.includes("[role=\"button\"]") ||
      (text && text.length > 2 && text.length < 50);

    if (!isSignificant) return null;

    const name = text?.slice(0, 30) || "Click";

    const step: Step = {
      id: `step-${++this.stepCounter}`,
      name: `Click: ${name}`,
      kind: "auto",
      timestamp: Date.now(),
      trigger: "click",
    };
    this.steps.push(step);
    this.callbacks.onStep(step);
    return step;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  getSteps(): Step[] {
    return [...this.steps];
  }

  clear(): void {
    this.steps = [];
    this.stepCounter = 0;
    this.lastNavUrl = null;
  }
}
