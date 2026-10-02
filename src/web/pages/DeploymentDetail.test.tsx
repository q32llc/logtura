import { MantineProvider } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { fireEvent,render,screen } from "@testing-library/react";
import { MemoryRouter,Route,Routes } from "react-router-dom";
import { beforeEach,expect,it,vi } from "vitest";
import type { DeploymentConfigurationState } from "@logtura/core";
import { api,ApiError } from "../api";
import type { ApiDeployment,ApiTargetBundle } from "../types";
import { DeploymentDetail } from "./DeploymentDetail";
const deployment:ApiDeployment={id:"dep_fixture",connectionId:"con_fixture",displayName:"Existing forwarder",targetKind:"fly",managed:false,status:"running",externalId:null,sourceIds:[],monitorIds:[],heartbeatTarget:"none",metricsTarget:null,metricsSnapshot:null,bundleOutdated:false,createdAt:0,updatedAt:0,lastSeenAt:null};
const bundle:ApiTargetBundle={target:{id:"fly",displayName:"Fly",supportsManaged:true},files:[],envVars:[],selfDeployInstructions:"Run the forwarder",selectedCount:0,monitorSummary:"No monitors",componentManifest:[]};
const revision=`sha256:${"a".repeat(64)}`,state:DeploymentConfigurationState={desired:{sequence:1,revision,configurationVersion:3,document:{kind:"logtura.deployment",schema_version:1,connections:[],monitors:[],runtimeEnv:null}},applied:null,activeInstanceId:null,lastReportSequence:0,stale:false};
function page(){return render(<MantineProvider><MemoryRouter initialEntries={["/app/deployments/dep_fixture"]}><Routes><Route path="/app/deployments/:id" element={<DeploymentDetail/>}/></Routes></MemoryRouter></MantineProvider>);}
beforeEach(()=>{
 vi.spyOn(api,"getDeployment").mockResolvedValue({deployment,latestDeployJob:null,connections:[]});vi.spyOn(api,"getDeploymentBundle").mockResolvedValue(bundle);vi.spyOn(api,"getDeploymentConfigurationState").mockResolvedValue(state);
 vi.spyOn(api,"listAllSources").mockResolvedValue({sources:[],connections:[]});vi.spyOn(api,"listMonitors").mockResolvedValue({monitors:[],sinks:[]});vi.spyOn(api,"listDestinations").mockResolvedValue({destinations:[]});vi.spyOn(api,"listDeployTargets").mockResolvedValue({deployTargets:[]});vi.spyOn(notifications,"show").mockReturnValue("notice");
});
it("shows linked CLI configuration status in the actual website deployment page",async()=>{
 page();expect(await screen.findByRole("heading",{name:"Existing forwarder"})).toBeTruthy();await screen.findByText("Waiting for forwarder");expect(screen.getByRole("region",{name:"Configuration revisions"})).toBeTruthy();expect(screen.getByText(/Desired revision #1/)).toBeTruthy();expect(screen.getByText("Applied revision: not reported")).toBeTruthy();expect(api.getDeploymentConfigurationState).toHaveBeenCalledWith("dep_fixture");
});
it("reloads desired/applied state after a website configuration save",async()=>{
 const updated={...deployment,displayName:"Updated forwarder"};vi.mocked(api.getDeployment).mockResolvedValueOnce({deployment,latestDeployJob:null,connections:[]}).mockResolvedValue({deployment:updated,latestDeployJob:null,connections:[]});vi.mocked(api.getDeploymentConfigurationState).mockResolvedValueOnce(state).mockResolvedValue({...state,stale:true});vi.spyOn(api,"updateDeployment").mockResolvedValue({deployment:updated});
 page();await screen.findByText("Waiting for forwarder");fireEvent.click(screen.getByRole("tab",{name:"Configure"}));fireEvent.change(screen.getByLabelText("Deployment name"),{target:{value:"Updated forwarder"}});fireEvent.click(screen.getByRole("button",{name:"Save changes"}));
 await screen.findByRole("heading",{name:"Updated forwarder"});await screen.findByText("Configuration changed");expect(api.updateDeployment).toHaveBeenCalledWith("dep_fixture",{displayName:"Updated forwarder",sourceIds:[],monitorIds:[],heartbeatTarget:"none",metricsTarget:null});expect(api.getDeploymentConfigurationState).toHaveBeenCalledTimes(2);
});
it("keeps the existing deployment usable when revision status is unavailable",async()=>{
 vi.mocked(api.getDeploymentConfigurationState).mockRejectedValue(new ApiError("private-error",503,"configuration_unavailable"));page();await screen.findByRole("heading",{name:"Existing forwarder"});await screen.findByText("Configuration status unavailable. Refresh to try again.");expect(screen.getByRole("tab",{name:"Configure"})).toBeTruthy();expect(document.body.textContent).not.toContain("private-error");
});
it.each([new ApiError("Deployment not found",404,"not_found"),new Error("Private network error")])("preserves deployment load failures without issuing a revision request",async error=>{
 vi.mocked(api.getDeployment).mockRejectedValue(error);page();await screen.findByText(error instanceof ApiError?"Deployment not found":"Failed to load");expect(api.getDeploymentConfigurationState).not.toHaveBeenCalled();
});
