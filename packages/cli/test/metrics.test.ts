import {afterEach,expect,it,vi} from "vitest";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {printStats} from "../src/metrics";
import {main} from "../src/main";
const roots:string[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function file(contents:string){const root=mkdtempSync(join(tmpdir(),"logt-stats-"));roots.push(root);const path=join(root,"metrics with spaces.json");writeFileSync(path,contents);return path;}
function metric(id:string,name:string,value:number,time=1_790_880_000_000,error_type?:string){return {name,namespace:"vector",timestamp:time,tags:{component_id:id,component_kind:"sink",component_type:"http",...(error_type?{error_type}:{})},counter:{value}};}
it("renders identical sorted tables from arrays and NDJSON, using latest counters and summed error series",async()=>{
 const events=[metric("z_sink","component_sent_events_total",20),metric("a_sink","vector_component_received_events_total",12),metric("z_sink","component_errors_total",2,undefined,"request"),metric("z_sink","component_errors_total",3,undefined,"encoding"),metric("z_sink","component_sent_events_total",1,1_790_879_000_000)];
 const expected="Component\tKind\tType\tReceived\tSent\tErrors\na_sink\tsink\thttp\t12\t-\t-\nz_sink\tsink\thttp\t-\t20\t5";
 expect(printStats(file(JSON.stringify(events)))).toBe(expected);const ndjson=file(events.map(e=>JSON.stringify(e)).join("\n\n"));expect(printStats(ndjson)).toBe(expected);
 const output=vi.spyOn(console,"log").mockImplementation(()=>{});expect(await main(["stats","--metrics",ndjson])).toBe(0);expect(output.mock.calls.at(-1)![0]).toBe(expected);expect(await main(["stats",ndjson])).toBe(0);
});
it("handles empty exports, pretty events, unknown labels and control characters without corrupting TSV",()=>{
 for(const text of [""," \n ","[]"])expect(printStats(file(text))).toBe("Component\tKind\tType\tReceived\tSent\tErrors");
 const event=metric("id\tprivate\nrow","component_received_events_total",1);event.tags.component_kind="invalid";event.tags.component_type="line\rbreak";expect(printStats(file(JSON.stringify(event,null,2)))).toBe("Component\tKind\tType\tReceived\tSent\tErrors\nid private row\tunknown\tline break\t1\t-\t-");
});
it("rejects malformed JSON without printing the input and preserves useful command exit codes",async()=>{
 const path=file('{"token":"private-secret"}\ninvalid');expect(()=>printStats(path)).toThrow("Invalid metrics JSON or NDJSON");const error=vi.spyOn(console,"error").mockImplementation(()=>{});expect(await main(["stats","--metrics",path])).toBe(1);expect(error.mock.calls.at(-1)![0]).not.toContain("private-secret");expect(await main(["stats",path,"--metrics",path])).toBe(1);expect(error.mock.calls.at(-1)![0]).toContain("one metrics file");expect(await main(["stats","--output",path])).toBe(1);expect(error.mock.calls.at(-1)![0]).toContain("Unsupported stats");expect(await main(["stats"])).toBe(1);expect(error.mock.calls.at(-1)![0]).toContain("requires --metrics");
});
