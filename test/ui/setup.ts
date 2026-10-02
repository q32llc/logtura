import { afterEach,vi } from "vitest";
import { cleanup } from "@testing-library/react";
if (typeof window !== "undefined") {
Object.defineProperty(window,"matchMedia",{writable:true,value:vi.fn().mockImplementation(query=>({matches:false,media:query,onchange:null,addListener:vi.fn(),removeListener:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn(),dispatchEvent:vi.fn()}))});
class ResizeObserver {observe(){}unobserve(){}disconnect(){}}
vi.stubGlobal("ResizeObserver",ResizeObserver);
// jsdom has no layout or scrolling implementation; Mantine's combobox
// scrolls the active option when keyboard or pointer selection changes.
Element.prototype.scrollIntoView = () => {};
}
afterEach(()=>{cleanup();vi.restoreAllMocks();});
