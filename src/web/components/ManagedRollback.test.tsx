import {MantineProvider} from "@mantine/core";
import {fireEvent,render,screen,waitFor} from "@testing-library/react";
import {beforeEach,expect,it,vi} from "vitest";
import {api} from "../api";
import type {ApiJob,ApiManagedRollbackState} from "../types";
import {ManagedRollback} from "./ManagedRollback";
const replacementId="11111111-1111-4111-8111-111111111111";
const available:ApiManagedRollbackState={configurationVersion:4,availableReplacementId:replacementId,rollback:null};
const job:ApiJob={id:"job_restore",kind:"fly_rollback",status:"queued",parentJobId:null,error:null,createdAt:0,updatedAt:0,startedAt:null,completedAt:null,result:null,progress:null};
const pending:ApiManagedRollbackState={...available,rollback:{id:"rollback",replacementId,status:"pending",phase:"rolling_back",oldMachineId:"legacy",candidateMachineId:"candidate"}};
const onJob=vi.fn(),onPending=vi.fn();
function page(current:ApiJob|null=null){return render(<MantineProvider env="test"><ManagedRollback deploymentId="dep" targetId="target" job={current} onJob={onJob} onPending={onPending}/></MantineProvider>);}
beforeEach(()=>{onJob.mockReset();onPending.mockReset();vi.spyOn(api,"getManagedRollback").mockResolvedValue(available);vi.spyOn(api,"restoreManagedForwarder").mockResolvedValue({job,deduped:false});});
it("uses a fresh explicit graph fence and submits the reviewed replacement only once",async()=>{
 page();const button=await screen.findByRole("button",{name:"Restore previous forwarder"});vi.mocked(api.getManagedRollback).mockResolvedValue({...available,configurationVersion:9});fireEvent.click(button);fireEvent.click(button);await waitFor(()=>expect(onJob).toHaveBeenCalledWith(job));expect(api.restoreManagedForwarder).toHaveBeenCalledExactlyOnceWith("dep",{replacementId,configurationVersion:9,deployTargetId:"target"});expect(onPending).toHaveBeenLastCalledWith(true);
});
it.each(["queued","running"] as const)("rehydrates %s restoration and disables another action",async status=>{
 vi.mocked(api.getManagedRollback).mockResolvedValue(pending);page({...job,status});await screen.findByText("Restoration is pending. The current instance can no longer report an applied revision.");expect((screen.getByRole("button",{name:"Retry restoration"}) as HTMLButtonElement).disabled).toBe(true);expect(api.restoreManagedForwarder).not.toHaveBeenCalled();
});
it("permits explicit retry after a failed job and updates the completed legacy message",async()=>{
 vi.mocked(api.getManagedRollback).mockResolvedValue(pending);const view=page({...job,status:"failed"});fireEvent.click(await screen.findByRole("button",{name:"Retry restoration"}));await waitFor(()=>expect(onJob).toHaveBeenCalledWith(job));
 vi.mocked(api.getManagedRollback).mockResolvedValue({...pending,availableReplacementId:null,rollback:{...pending.rollback!,status:"completed",phase:"rolled_back"}});view.rerender(<MantineProvider env="test"><ManagedRollback deploymentId="dep" targetId="target" job={{...job,status:"succeeded"}} onJob={onJob} onPending={onPending}/></MantineProvider>);await screen.findByText("Previous forwarder restored. Its portable configuration revision is unknown.");expect(screen.queryByRole("button")).toBeNull();expect(onPending).toHaveBeenLastCalledWith(false);
});
it("does not silently restore a different replacement than the one reviewed",async()=>{
 page();const button=await screen.findByRole("button",{name:"Restore previous forwarder"});vi.mocked(api.getManagedRollback).mockResolvedValue({...available,availableReplacementId:"22222222-2222-4222-8222-222222222222"});fireEvent.click(button);await screen.findByText("Replacement changed. Review the current forwarder before restoring.");expect(api.restoreManagedForwarder).not.toHaveBeenCalled();
});
it("shows static failures without exposing private response details and permits retry",async()=>{
 page();const button=await screen.findByRole("button",{name:"Restore previous forwarder"});vi.mocked(api.restoreManagedForwarder).mockRejectedValueOnce(new Error("private-provider-token"));fireEvent.click(button);await screen.findByText("Could not start restoration. Refresh and try again.");expect(document.body.textContent).not.toContain("private-provider-token");fireEvent.click(button);await waitFor(()=>expect(onJob).toHaveBeenCalledWith(job));
});
it("renders a static status failure and prevents acting on unavailable recovery state",async()=>{
 vi.mocked(api.getManagedRollback).mockRejectedValue(new Error("private-journal"));page();await screen.findByText("Restoration status unavailable. Refresh to try again.");expect(screen.queryByRole("button")).toBeNull();expect(document.body.textContent).not.toContain("private-journal");
});
it("renders nothing when no legacy replacement or rollback exists",async()=>{
 vi.mocked(api.getManagedRollback).mockResolvedValue({...available,availableReplacementId:null});page();await waitFor(()=>expect(onPending).toHaveBeenCalledWith(false));expect(screen.queryByRole("button")).toBeNull();expect(screen.queryByText(/Restore the retained/)).toBeNull();
});
it("ignores late status completion after unmount",async()=>{
 let finish!:(state:ApiManagedRollbackState)=>void;vi.mocked(api.getManagedRollback).mockImplementation(()=>new Promise(resolve=>finish=resolve));const view=page();view.unmount();finish(available);await Promise.resolve();expect(onPending).not.toHaveBeenCalled();
});
it("disables restoration while retained-machine retirement is pending",async()=>{
 render(<MantineProvider env="test"><ManagedRollback deploymentId="dep" targetId="target" job={null} onJob={onJob} onPending={onPending} blocked/></MantineProvider>);const button=await screen.findByRole("button",{name:"Restore previous forwarder"});expect((button as HTMLButtonElement).disabled).toBe(true);fireEvent.click(button);expect(api.restoreManagedForwarder).not.toHaveBeenCalled();
});
it("offers restoration for a newly installed replacement instead of showing older historical restoration",async()=>{
 vi.mocked(api.getManagedRollback).mockResolvedValue({...pending,rollback:{...pending.rollback!,status:"completed",phase:"rolled_back"}});page();await screen.findByRole("button",{name:"Restore previous forwarder"});expect(screen.queryByText("Previous forwarder restored. Its portable configuration revision is unknown.")).toBeNull();
});
