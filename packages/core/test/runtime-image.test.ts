import { expect,it } from "vitest";
import { runtimeImageFiles,runtimeImageEntrypoint,FORWARDER_NODE_IMAGE } from "../src/runtime-image";
import { renderDockerfile } from "../src/render";
it("composes trusted runtime bytes separately from private deployment state",()=>{
 const bytes=new Uint8Array([0,255,1]),files=runtimeImageFiles(bytes);expect(files).toEqual([{name:"runtime/runtime-bin.mjs",content:bytes,mode:0o644},{name:"runtime/entrypoint.sh",content:runtimeImageEntrypoint(),mode:0o755}]);expect(runtimeImageFiles("packaged-code")[0]!.content).toBe("packaged-code");
 for(const value of ["",new Uint8Array(),null,{}])expect(()=>runtimeImageFiles(value as string)).toThrow("packaged executable");
});
it("inherits Vector's entrypoint once and opts into the compatible runtime image explicitly",()=>{
 const legacy=renderDockerfile([]),modern=renderDockerfile([],{runtimeSupervisor:true,mountVectorYamlAtRuntime:true,includeRuntimeAssets:true});
 expect(legacy).toContain('CMD ["--config", "/etc/vector/vector.yaml"]');expect(legacy).not.toContain('CMD ["vector"');expect(legacy).not.toContain("logtura-node");
 expect(modern).toContain(`FROM ${FORWARDER_NODE_IMAGE} AS logtura-node`);expect(modern).toContain("libstdc++6");expect(modern).toContain("COPY --from=logtura-node /usr/local/bin/node /usr/local/bin/node");expect(modern).toContain('ENTRYPOINT ["/opt/logtura/runtime/entrypoint.sh"]');expect(modern).toContain("STOPSIGNAL SIGTERM");expect(modern).not.toContain("COPY vector.yaml");expect(modern).toContain("COPY assets/");expect(modern).not.toContain("COPY logtura-runtime.json");
});
