import { MantineProvider } from "@mantine/core";
import { render,screen,waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach,describe,expect,it,vi } from "vitest";
import { api } from "../api";
import { CliAccess } from "./CliAccess";
const user={id:"usr_fixture",githubLogin:"fixture",name:"Fixture",email:null,avatarUrl:null};
const device={userCode:"ABCD-EFGH",label:"My terminal",expiresAt:Date.now()+60_000,decision:"pending" as const,scope:"account:read account:write"};
function page({anonymous=false,loading=false,code=true}={}){return render(<MantineProvider><MemoryRouter initialEntries={[code?"/app/cli?code=ABCD-EFGH":"/app/cli"]}><CliAccess user={anonymous?null:user} loading={loading}/></MemoryRouter></MantineProvider>);}
beforeEach(()=>{vi.spyOn(api,"cliTokens").mockResolvedValue({tokens:[]});vi.spyOn(api,"cliDevice").mockResolvedValue(device);vi.spyOn(api,"decideCliDevice").mockResolvedValue({ok:true});vi.spyOn(api,"revokeCliToken").mockResolvedValue({ok:true});vi.spyOn(api,"persistCliToken").mockResolvedValue({expiresAt:253402300799999,scope:"account:read account:write"});});
describe("browser CLI account approval",()=>{
 it("shows loading and retains the approval URL through sign-in",()=>{const first=page({loading:true,anonymous:true});expect(screen.getByLabelText("Loading account")).toBeTruthy();first.unmount();page({anonymous:true});expect(screen.getByRole("link",{name:"Sign in with GitHub"}).getAttribute("href")).toContain(encodeURIComponent("/app/cli?code=ABCD-EFGH"));expect(api.cliDevice).not.toHaveBeenCalled();});
 it("requires an explicit decision with the matching terminal code and account",async()=>{page();expect(await screen.findByText("ABCD-EFGH")).toBeTruthy();expect(screen.getByText("My terminal")).toBeTruthy();expect(screen.getByText(/The CLI will be able to read and update/)).toBeTruthy();expect(api.decideCliDevice).not.toHaveBeenCalled();await userEvent.click(screen.getByRole("button",{name:"Approve CLI access"}));expect(await screen.findByText(/Approved. Return to your terminal/)).toBeTruthy();expect(api.decideCliDevice).toHaveBeenCalledWith("ABCD-EFGH",true);});
 it("lets the user deny and revoke account access",async()=>{vi.mocked(api.cliTokens).mockResolvedValueOnce({tokens:[{id:"cli_fixture",label:"Old terminal",created_at:0,expires_at:Date.now()+60_000,revoked_at:null}]}).mockResolvedValue({tokens:[]});page();await screen.findByText("Old terminal");await userEvent.click(screen.getByRole("button",{name:"Deny"}));expect(await screen.findByText("Access denied.")).toBeTruthy();expect(api.decideCliDevice).toHaveBeenCalledWith("ABCD-EFGH",false);await userEvent.click(screen.getByRole("button",{name:"Revoke"}));await waitFor(()=>expect(screen.queryByText("Old terminal")).toBeNull());expect(api.revokeCliToken).toHaveBeenCalledWith("cli_fixture");});
 it("shows approved/denied device state when revisiting and instructions without a code",async()=>{vi.mocked(api.cliDevice).mockResolvedValue({...device,decision:"denied"});const first=page();expect(await screen.findByText("Access denied.")).toBeTruthy();first.unmount();page({code:false});expect(screen.getByText("logt login")).toBeTruthy();expect(await screen.findByText("No active CLI clients.")).toBeTruthy();});
 it("reports lookup and decision failures so approval can be retried",async()=>{vi.mocked(api.cliDevice).mockRejectedValueOnce(new Error("Link expired"));const first=page();expect((await screen.findByRole("alert")).textContent).toContain("Link expired");first.unmount();vi.mocked(api.decideCliDevice).mockRejectedValueOnce(new Error("Try again"));page();await screen.findByText("ABCD-EFGH");await userEvent.click(screen.getByRole("button",{name:"Approve CLI access"}));expect((await screen.findByRole("alert")).textContent).toContain("Try again");expect(screen.getByRole("button",{name:"Approve CLI access"})).toBeTruthy();});
 it("reports list/revocation errors and excludes expired/revoked credentials",async()=>{vi.mocked(api.cliTokens).mockRejectedValueOnce(new Error("Unavailable"));const first=page({code:false});expect((await screen.findByRole("alert")).textContent).toContain("Unavailable");first.unmount();vi.mocked(api.cliTokens).mockResolvedValue({tokens:[{id:"cli_active",label:"Active",created_at:0,expires_at:Date.now()+60_000,revoked_at:null},{id:"cli_expired",label:"Expired",created_at:0,expires_at:0,revoked_at:null},{id:"cli_revoked",label:"Revoked",created_at:0,expires_at:Date.now()+60_000,revoked_at:1}]});vi.mocked(api.revokeCliToken).mockRejectedValueOnce(new Error("Retry revoke"));page({code:false});await screen.findByText("Active");expect(screen.queryByText("Expired")).toBeNull();expect(screen.queryByText("Revoked")).toBeNull();await userEvent.click(screen.getByRole("button",{name:"Revoke"}));expect((await screen.findByRole("alert")).textContent).toContain("Retry revoke");});
});

it("keeps approval and revocation usable after unexpected failures",async()=>{
 vi.mocked(api.cliTokens).mockResolvedValue({tokens:[{id:"cli_fixture",label:"Terminal",created_at:0,expires_at:Date.now()+60_000,revoked_at:null}]});
 vi.mocked(api.decideCliDevice).mockRejectedValueOnce("unexpected");vi.mocked(api.revokeCliToken).mockRejectedValueOnce("unexpected");page();
 await screen.findByText("ABCD-EFGH");await userEvent.click(screen.getByRole("button",{name:"Approve CLI access"}));expect((await screen.findByRole("alert")).textContent).toContain("Could not authorize CLI");
 await userEvent.click(screen.getByRole("button",{name:"Revoke"}));await waitFor(()=>expect(screen.getByRole("alert").textContent).toContain("Could not revoke access"));
});


it("retains a chosen client only after an explicit action and displays its permanent revocable lifetime",async()=>{
 const active={id:"cli_smoke",label:"Local production smoke",created_at:0,expires_at:Date.now()+60000,revoked_at:null};
 vi.mocked(api.cliTokens).mockResolvedValueOnce({tokens:[active]}).mockResolvedValue({tokens:[{...active,expires_at:253402300799999}]});
 page({code:false});await screen.findByText(active.label);expect(api.persistCliToken).not.toHaveBeenCalled();await userEvent.click(screen.getByRole("button",{name:"Keep until revoked"}));expect(await screen.findByText("Does not expire; revoke to remove access")).toBeTruthy();expect(api.persistCliToken).toHaveBeenCalledWith(active.id);expect(screen.queryByRole("button",{name:"Keep until revoked"})).toBeNull();expect(screen.getByRole("button",{name:"Revoke"})).toBeTruthy();
});

it("keeps temporary access and reports failed lifetime changes",async()=>{
 vi.mocked(api.cliTokens).mockResolvedValue({tokens:[{id:"cli_smoke",label:"Local production smoke",created_at:0,expires_at:Date.now()+60000,revoked_at:null}]});
 vi.mocked(api.persistCliToken).mockRejectedValueOnce(new Error("Retry retention")).mockRejectedValueOnce("unexpected");page({code:false});await screen.findByText("Local production smoke");await userEvent.click(screen.getByRole("button",{name:"Keep until revoked"}));expect((await screen.findByRole("alert")).textContent).toContain("Retry retention");await userEvent.click(screen.getByRole("button",{name:"Keep until revoked"}));await waitFor(()=>expect(screen.getByRole("alert").textContent).toContain("Could not retain access"));expect(screen.queryByText("Does not expire; revoke to remove access")).toBeNull();
});
