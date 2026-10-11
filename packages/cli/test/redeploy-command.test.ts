import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";

const redeployHostedDeployment=vi.fn();
vi.mock("../src/redeploy",()=>({redeployHostedDeployment}));

import {main} from "../src/main";

describe("redeploy command",()=>{
 beforeEach(()=>{
  vi.stubEnv("LOGT_SERVICE_TOKEN",`lt_cli_${"a".repeat(43)}`);
  vi.spyOn(console,"log").mockImplementation(()=>{});
  vi.spyOn(console,"error").mockImplementation(()=>{});
  redeployHostedDeployment.mockReset().mockResolvedValue({targetId:"target",deduped:false,job:{id:"job",kind:"fly_deploy",status:"queued",error:null,result:null,progress:null}});
 });
 afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});

 it("dispatches a hosted redeploy with CLI overrides",async()=>{
  expect(await main(["redeploy","dep_fixture","--service","https://fixture.test","--target","target","--region","iad","--wait-seconds","0"])).toBe(0);
  expect(redeployHostedDeployment).toHaveBeenCalledWith(expect.objectContaining({url:"https://fixture.test"}),"dep_fixture",{targetId:"target",region:"iad",waitMs:0});
  expect(console.log).toHaveBeenCalledWith("Redeployed dep_fixture with job job");
 });

 it("supports JSON output and validates its arguments",async()=>{
  expect(await main(["--json","redeploy","dep_fixture"])).toBe(0);
  expect(JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])).job.id).toBe("job");
  expect(await main(["redeploy"])).toBe(1);
  expect(console.error).toHaveBeenLastCalledWith("redeploy requires a deployment identity");
  expect(await main(["redeploy","dep_fixture","--force"])).toBe(1);
  expect(console.error).toHaveBeenLastCalledWith("Unsupported redeploy option: force");
 });
});
