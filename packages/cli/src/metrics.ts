import {readFileSync} from "node:fs";
import {parseMetricsBody,applyMetricsToSnapshot} from "@logtura/core";

export function printStats(path:string):string {
  const text=readFileSync(path,"utf8"),events=parseMetricsBody(text,{strict:true});
  const snapshot=applyMetricsToSnapshot(null,events),lines=["Component\tKind\tType\tReceived\tSent\tErrors"];
  for(const [id,component] of Object.entries(snapshot.byComponent).sort(([a],[b])=>a.localeCompare(b))) {
    const cell=(value:string)=>value.replace(/[\t\r\n]/g," ");
    lines.push([cell(id),cell(component.kind),cell(component.type),component.received??"-",component.sent??"-",component.errors??"-"].join("\t"));
  }
  return lines.join("\n");
}
