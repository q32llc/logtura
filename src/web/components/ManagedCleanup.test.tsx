import {MantineProvider} from "@mantine/core";
import {fireEvent,render,screen,waitFor} from "@testing-library/react";
import {beforeEach,expect,it,vi} from "vitest";
import {api} from "../api";
import type {ApiJob,ApiManagedCleanupState} from "../types";
import {ManagedCleanup} from "./ManagedCleanup";
const replacementId="11111111-1111-4111-8111-111111111111",available:ApiManagedCleanupState={configurationVersion:4,availableReplacementId:replacementId,cleanup:null};
const job:ApiJob={id:"job_cleanup",kind:"fly_cleanup",status:"queued",parentJobId:null,error:null,createdAt:0,updatedAt:0,startedAt:null,completedAt:null,result:null,progress:null};
const pending:ApiManagedCleanupState={...available,cleanup:{id:"cleanup",replacementId,status:"pending",phase:"deleting",survivorId:"legacy",retiredId:"candidate"}},onJob=vi.fn(),onPending=vi.fn();
function page(current:ApiJob|null=null){return render(<MantineProvider env="test"><ManagedCleanup deploymentId="dep" targetId="target" job={current} onJob={onJob} onPending={onPending}/></MantineProvider>);}
beforeEach(()=>{onJob.mockReset();onPending.mockReset();vi.spyOn(api,"getManagedCleanup").mockResolvedValue(available);vi.spyOn(api,"retireManagedForwarder").mockResolvedValue({job,deduped:false});});
it("requires irreversible confirmation, refreshes its graph fence and submits one explicit decision",async()=>{
 page();const button=await screen.findByRole("button",{name:"Remove retained machine"});expect((button as HTMLButtonElement).disabled).toBe(true);fireEvent.click(button);expect(api.retireManagedForwarder).not.toHaveBeenCalled();fireEvent.click(screen.getByRole("checkbox"));vi.mocked(api.getManagedCleanup).mockResolvedValue({...available,configurationVersion:9});fireEvent.click(button);fireEvent.click(button);await waitFor(()=>expect(onJob).toHaveBeenCalledWith(job));expect(api.retireManagedForwarder).toHaveBeenCalledExactlyOnceWith("dep",{replacementId,configurationVersion:9,deployTargetId:"target",confirmRetirement:true});expect(onPending).toHaveBeenLastCalledWith(true);
});
it.each(["queued","running"] as const)("rehydrates %s cleanup and disables another request",async status=>{
 vi.mocked(api.getManagedCleanup).mockResolvedValue(pending);page({...job,status});await screen.findByText(/Machine removal is pending/);expect((screen.getByRole("button",{name:"Observe machine removal"}) as HTMLButtonElement).disabled).toBe(true);expect(screen.queryByRole("checkbox")).toBeNull();
});
it("observes an existing decision after failure and renders confirmed removal after reload",async()=>{
 vi.mocked(api.getManagedCleanup).mockResolvedValue(pending);const view=page({...job,status:"failed"});fireEvent.click(await screen.findByRole("button",{name:"Observe machine removal"}));await waitFor(()=>expect(onJob).toHaveBeenCalledWith(job));vi.mocked(api.getManagedCleanup).mockResolvedValue({...pending,availableReplacementId:null,cleanup:{...pending.cleanup!,status:"completed",phase:"deleted"}});view.rerender(<MantineProvider env="test"><ManagedCleanup deploymentId="dep" targetId="target" job={{...job,status:"succeeded"}} onJob={onJob} onPending={onPending}/></MantineProvider>);await screen.findByText("Retained machine removed. The surviving forwarder and checkpoint storage are preserved.");expect(screen.queryByRole("button")).toBeNull();expect(onPending).toHaveBeenLastCalledWith(false);
});
it("requires review again when the replacement changes between review and submission",async()=>{
 page();const button=await screen.findByRole("button",{name:"Remove retained machine"});fireEvent.click(screen.getByRole("checkbox"));vi.mocked(api.getManagedCleanup).mockResolvedValue({...available,availableReplacementId:"different"});fireEvent.click(button);await screen.findByText("Replacement changed. Review the retained machine before removing it.");expect(api.retireManagedForwarder).not.toHaveBeenCalled();expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
});
it("keeps provider errors private and permits a confirmed retry",async()=>{
 vi.mocked(api.retireManagedForwarder).mockRejectedValueOnce(new Error("private-provider"));page();fireEvent.click(await screen.findByRole("checkbox"));fireEvent.click(screen.getByRole("button"));await screen.findByText("Could not start machine removal. Refresh and try again.");expect(document.body.textContent).not.toContain("private-provider");fireEvent.click(screen.getByRole("button"));await waitFor(()=>expect(onJob).toHaveBeenCalledWith(job));
});
it("fails closed on unavailable status and ignores late unmounted results",async()=>{
 vi.mocked(api.getManagedCleanup).mockRejectedValue(new Error("private-journal"));const view=page();await screen.findByText("Retained machine status unavailable. Refresh to try again.");expect(onPending).toHaveBeenLastCalledWith(true);expect(screen.queryByRole("button")).toBeNull();view.unmount();onPending.mockReset();let finish!:(state:ApiManagedCleanupState)=>void;vi.mocked(api.getManagedCleanup).mockImplementation(()=>new Promise(resolve=>finish=resolve));const unmounted=page();unmounted.unmount();finish(available);await Promise.resolve();expect(onPending).not.toHaveBeenCalled();
});
it("renders nothing without any retained machine and permits a newly reviewed replacement after older cleanup",async()=>{
 vi.mocked(api.getManagedCleanup).mockResolvedValue({...available,availableReplacementId:null});const view=page();await waitFor(()=>expect(onPending).toHaveBeenCalledWith(false));expect(screen.queryByText(/Permanently remove/)).toBeNull();vi.mocked(api.getManagedCleanup).mockResolvedValue({...available,cleanup:{...pending.cleanup!,status:"completed",phase:"deleted"}});view.rerender(<MantineProvider env="test"><ManagedCleanup deploymentId="dep" targetId="target" job={{...job,status:"succeeded"}} onJob={onJob} onPending={onPending}/></MantineProvider>);await screen.findByRole("checkbox");expect(screen.queryByText(/Retained machine removed/)).toBeNull();
});
