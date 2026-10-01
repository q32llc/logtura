import { Alert, Button, Code, Group, Loader, Paper, Stack, Text, Title } from "@mantine/core";
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { api, type CliDevice, type CliAccountToken } from "../api";
import type { ApiUser } from "../types";

export function CliAccess({user,loading}: {user: ApiUser | null;loading: boolean}) {
  const location=useLocation();const code=new URLSearchParams(location.search).get("code");
  const [device,setDevice]=useState<CliDevice|null>(null);
  const [tokens,setTokens]=useState<CliAccountToken[]>([]);
  const [error,setError]=useState<string|null>(null);const [busy,setBusy]=useState(false);
  useEffect(()=>{
    if (!user) return;
    let cancelled=false;setDevice(null);setError(null);
    api.cliTokens().then(r=>{if(!cancelled)setTokens(r.tokens);}).catch(err=>{if(!cancelled)setError(err.message);});
    if(code) api.cliDevice(code).then(r=>{if(!cancelled)setDevice(r);}).catch(err=>{if(!cancelled)setError(err.message);});
    return()=>{cancelled=true;};
  },[user,code]);
  const decide=async(approve:boolean)=>{
    if(!code)return;setBusy(true);setError(null);
    try {await api.decideCliDevice(code,approve);setDevice(current=>current?{...current,decision:approve?"approved":"denied"}:current);}
    catch(err){setError(err instanceof Error?err.message:"Could not authorize CLI");}finally{setBusy(false);}
  };
  const revoke=async(id:string)=>{
    setBusy(true);setError(null);
    try{await api.revokeCliToken(id);setTokens((await api.cliTokens()).tokens);}
    catch(err){setError(err instanceof Error?err.message:"Could not revoke access");}finally{setBusy(false);}
  };
  if(loading)return <Loader aria-label="Loading account" />;
  return <Stack maw={680} mx="auto">
    <Title order={2}>CLI access</Title>
    {!user ? <>
      <Text>Sign in to authorize the CLI for your Logtura account.</Text>
      <Button component="a" href={`/login/github?return_to=${encodeURIComponent(location.pathname+location.search)}`}>Sign in with GitHub</Button>
    </> : <>
      {error && <Alert color="red" role="alert">{error}</Alert>}
      {device && <Paper withBorder p="lg"><Stack>
        <Text>Requested by <strong>{device.label}</strong> for <strong>{user.githubLogin}</strong>.</Text>
        <Text>Check that this code matches the one shown in your terminal:</Text>
        <Code fz="xl">{device.userCode}</Code>
        <Text>The CLI will be able to read and update your account’s connections, routing and deployments, including credentials needed to run your forwarder. Access expires after 90 days and can be revoked below.</Text>
        {device.decision==="pending" ? <Group>
          <Button loading={busy} onClick={()=>void decide(true)}>Approve CLI access</Button>
          <Button disabled={busy} variant="outline" color="red" onClick={()=>void decide(false)}>Deny</Button>
        </Group> : <Text>{device.decision==="approved"?"Approved. Return to your terminal to finish signing in.":"Access denied."}</Text>}
      </Stack></Paper>}
      {!code && <Text>Run <Code>logt login</Code> in your terminal to connect the CLI to this account.</Text>}
      <Title order={3}>Authorized clients</Title>
      {tokens.filter(token=>token.revoked_at===null && token.expires_at>Date.now()).map(token=><Paper withBorder p="md" key={token.id}><Group justify="space-between">
        <Stack gap={0}><Text>{token.label}</Text><Text size="sm" c="dimmed">Expires {new Date(token.expires_at).toLocaleDateString()}</Text></Stack>
        <Button color="red" variant="outline" disabled={busy} onClick={()=>void revoke(token.id)}>Revoke</Button>
      </Group></Paper>)}
      {!tokens.some(token=>token.revoked_at===null && token.expires_at>Date.now()) && <Text c="dimmed">No active CLI clients.</Text>}
    </>}
  </Stack>;
}
