import { MantineProvider } from "@mantine/core";
import { act,fireEvent,render,screen,waitFor } from "@testing-library/react";
import { beforeEach,expect,it,vi } from "vitest";
import type { DeploymentConfigurationState } from "@logtura/core";
import { api } from "../api";
import { DeploymentRevisionStatus,revisionStatus } from "./DeploymentRevisionStatus";
const revision=`sha256:${"a".repeat(64)}`,older=`sha256:${"b".repeat(64)}`,instance="00000000-0000-4000-8000-000000000001";
function state(patch:Partial<DeploymentConfigurationState>={}):DeploymentConfigurationState{return {desired:{sequence:2,revision,document:{kind:"logtura.deployment",schema_version:1,connections:[],monitors:[],runtimeEnv:null},configurationVersion:4},applied:{sequence:2,revision,at:1000},activeInstanceId:instance,lastReportSequence:1,stale:false,...patch};}
function page(deploymentId="dep_fixture",refreshKey?:number){return <MantineProvider><DeploymentRevisionStatus deploymentId={deploymentId} refreshKey={refreshKey}/></MantineProvider>;}
beforeEach(()=>{vi.spyOn(api,"getDeploymentConfigurationState").mockResolvedValue(state());});
it("shows loading and both desired/applied revision identities without exposing manifests or instance IDs",async()=>{
 render(page());expect(screen.getByLabelText("Loading configuration status")).toBeTruthy();expect(screen.getByRole("button",{name:"Refresh configuration status"}).hasAttribute("disabled")).toBe(true);
 await screen.findByText("In sync");expect(screen.getByText(/Desired revision #2/).getAttribute("title")).toBe(revision);expect(screen.getByText(/Last applied revision #2/).getAttribute("title")).toBe(revision);expect(screen.getByText(/^Reported /)).toBeTruthy();expect(screen.queryByLabelText("Loading configuration status")).toBeNull();expect(document.body.textContent).not.toContain(instance);expect(document.body.textContent).not.toContain("logtura.deployment");
});
it("distinguishes legacy, unreported, replacement, pending and stale configurations",async()=>{
 expect(revisionStatus(state({activeInstanceId:null})).label).toBe("Waiting for forwarder");expect(revisionStatus(state({lastReportSequence:0})).label).toBe("Waiting for forwarder");expect(revisionStatus(state({applied:null})).label).toBe("Waiting for forwarder");expect(revisionStatus(state({applied:{sequence:1,revision:older,at:0}})).label).toBe("Update pending");expect(revisionStatus(state({stale:true})).label).toBe("Configuration changed");
 vi.mocked(api.getDeploymentConfigurationState).mockResolvedValueOnce(null).mockResolvedValueOnce(state({applied:null,activeInstanceId:null,lastReportSequence:0})).mockResolvedValueOnce(state({lastReportSequence:0})).mockResolvedValueOnce(state({applied:{sequence:1,revision:older,at:Number.MAX_SAFE_INTEGER}})).mockResolvedValueOnce(state({stale:true}));
 render(page());await screen.findByText("No configuration revision has been recorded for this deployment.");
 fireEvent.click(screen.getByRole("button",{name:"Refresh configuration status"}));await screen.findByText("Applied revision: not reported");expect(screen.getByText("Waiting for forwarder")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Refresh configuration status"}));await screen.findByText(/Last applied revision #2/);expect(screen.getByText("Waiting for forwarder")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Refresh configuration status"}));await screen.findByText("Update pending");expect(screen.getByText(/Last applied revision #1/).getAttribute("title")).toBe(older);expect(screen.getByText("Reported Unknown time")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Refresh configuration status"}));await screen.findByText("Configuration changed");expect(screen.getByText(/Sync before updating/)).toBeTruthy();
});
it("keeps errors local and allows retry without reflecting server details",async()=>{
 vi.mocked(api.getDeploymentConfigurationState).mockRejectedValueOnce(new Error("private-storage-detail")).mockResolvedValueOnce(state());render(page());await screen.findByText("Configuration status unavailable. Refresh to try again.");expect(document.body.textContent).not.toContain("private-storage-detail");fireEvent.click(screen.getByRole("button",{name:"Refresh configuration status"}));await screen.findByText("In sync");expect(screen.queryByText(/unavailable/)).toBeNull();
});
it("refreshes after saves and ignores late replies for another deployment or an unmounted view",async()=>{
 let resolveOld!:(state:DeploymentConfigurationState|null)=>void;
 vi.mocked(api.getDeploymentConfigurationState).mockImplementationOnce(()=>new Promise(resolve=>{resolveOld=resolve;})).mockResolvedValueOnce(state()).mockResolvedValueOnce(state({stale:true}));const view=render(page("dep_old",0));view.rerender(page("dep_new",0));await screen.findByText("In sync");await act(async()=>resolveOld(null));expect(screen.queryByText(/No configuration revision/)).toBeNull();view.rerender(page("dep_new",1));await screen.findByText("Configuration changed");expect(api.getDeploymentConfigurationState).toHaveBeenNthCalledWith(3,"dep_new");
 let rejectOld!:(error:Error)=>void;vi.mocked(api.getDeploymentConfigurationState).mockImplementationOnce(()=>new Promise((_,reject)=>{rejectOld=reject;}));view.rerender(page("dep_pending",1));view.unmount();await act(async()=>rejectOld(new Error("late-private-error")));await waitFor(()=>expect(screen.queryByText(/unavailable/)).toBeNull());
});
