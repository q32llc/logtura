import { MantineProvider } from "@mantine/core";
import { render,screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach,expect,it,vi } from "vitest";
import { api,ApiError } from "../api";
import type { ApiDeployment,ApiConnection } from "../types";
import { deploymentSourceSummary } from "../deployment-selection";
import { Deployments } from "./Deployments";
const connection={id:"con_fixture",displayName:"Account"} as ApiConnection;
function deployment(overrides:Partial<ApiDeployment>={}):ApiDeployment{return {id:"dep_fixture",connectionId:connection.id,displayName:"Fixture forwarder",targetKind:"fly",managed:false,status:"running",externalId:null,sourceIds:[],monitorIds:[],heartbeatTarget:"none",metricsTarget:null,metricsSnapshot:null,bundleOutdated:false,createdAt:0,updatedAt:0,lastSeenAt:null,...overrides};}
function page(){return render(<MantineProvider><MemoryRouter><Deployments/></MemoryRouter></MantineProvider>);}
beforeEach(()=>{vi.spyOn(api,"listDeployments").mockResolvedValue({deployments:[]});vi.spyOn(api,"listConnections").mockResolvedValue({connections:[]});});
it("shows loading and the empty account's connection path",async()=>{
  page();expect(screen.getByLabelText("Loading deployments")).toBeTruthy();expect(await screen.findByText("No deployments yet.")).toBeTruthy();expect(screen.getByRole("link",{name:"Add a connection first"}).getAttribute("href")).toBe("/app/connections/new");expect(screen.queryByLabelText("Loading deployments")).toBeNull();
});
it("offers creation using an existing account connection",async()=>{
  vi.mocked(api.listConnections).mockResolvedValue({connections:[connection]});page();await screen.findByText("No deployments yet.");for(const name of ["New deployment","Create your first deployment"])expect(screen.getByRole("link",{name}).getAttribute("href")).toBe("/app/connections/con_fixture/deploy");
});
it("renders CLI all-source mode, managed/outdated state, and explicit sources with correct navigation",async()=>{
  const all=deployment({managed:true,bundleOutdated:true,graphSelection:{schema_version:1,connections:[{id:connection.id,sourceIds:[],selectAll:true}],monitors:[]}});
  const explicit=deployment({id:"dep_explicit",connectionId:"con_deleted",displayName:"Explicit",sourceIds:["src_one"],monitorIds:["mon_one"],status:"stopped"});
  vi.mocked(api.listDeployments).mockResolvedValue({deployments:[all,explicit]});vi.mocked(api.listConnections).mockResolvedValue({connections:[connection]});page();await screen.findByText("Fixture forwarder");expect(screen.getByText(/All current and future sources from 1 connection/)).toBeTruthy();expect(screen.getByText(/con_deleted · 1 selected source · 1 monitors/)).toBeTruthy();expect(screen.getByText("managed")).toBeTruthy();expect(screen.getByText("out of date")).toBeTruthy();expect(screen.getByRole("link",{name:"Redeploy"}).getAttribute("href")).toBe("/app/deployments/dep_fixture?action=deploy");expect(screen.getByRole("link",{name:"Fixture forwarder"}).getAttribute("href")).toBe("/app/deployments/dep_fixture");expect(screen.getAllByRole("link",{name:"View"})).toHaveLength(2);
});
it("renders legacy wildcard selectors and reports both API and unexpected load failures",async()=>{
  vi.mocked(api.listDeployments).mockResolvedValueOnce({deployments:[deployment({sourceIds:null,monitorIds:null})]});const first=page();expect(await screen.findByText(/All discovered sources from the connection · all monitors/)).toBeTruthy();first.unmount();
  vi.mocked(api.listDeployments).mockRejectedValueOnce(new ApiError("Account unavailable",503));const second=page();expect((await screen.findByRole("alert")).textContent).toContain("Account unavailable");second.unmount();
  vi.mocked(api.listConnections).mockRejectedValueOnce("unexpected");page();expect((await screen.findByRole("alert")).textContent).toContain("Failed to load");
});
it("summarizes mixed all-source/explicit configurations and section-specific website overrides",()=>{
  const graph={schema_version:1 as const,connections:[{id:"con_one",sourceIds:[],selectAll:true},{id:"con_two",sourceIds:[],selectAll:true},{id:"con_list",sourceIds:["a","b"]}],monitors:[]};
  expect(deploymentSourceSummary({sourceIds:[]})).toBe("0 selected sources");
  expect(deploymentSourceSummary({graphSelection:graph,sourceIds:[]})).toBe("All current and future sources from 2 connections, plus 2 selected");
  expect(deploymentSourceSummary({graphSelection:{...graph,legacySources:true},sourceIds:["one"]})).toBe("1 selected source");
  expect(deploymentSourceSummary({graphSelection:{...graph,connections:[{id:"only",sourceIds:["one"]}]},sourceIds:[]})).toBe("1 selected source");
  expect(deploymentSourceSummary({graphSelection:{...graph,connections:[{id:"only",sourceIds:[]}]},sourceIds:[]})).toBe("0 selected sources");
});

it("shows discovered catalog refresh policies in deployment summaries",()=>{
  expect(deploymentSourceSummary({graphSelection:{schema_version:1,connections:[{id:"discovered",sourceIds:["current"],discoverSources:true},{id:"explicit",sourceIds:["one"]}],monitors:[]},sourceIds:[]})).toBe("All discovered sources on refresh from 1 connection, plus 1 selected");
});

it("distinguishes native subscriptions from refreshed discovered catalogs",()=>{
  expect(deploymentSourceSummary({graphSelection:{schema_version:1,connections:[{id:"one",sourceIds:[],discoverSources:true},{id:"two",sourceIds:[],discoverSources:true},{id:"native",sourceIds:[],selectAll:true}],monitors:[]},sourceIds:[]})).toBe("All current and future sources from 1 connection, plus All discovered sources on refresh from 2 connections");
});
