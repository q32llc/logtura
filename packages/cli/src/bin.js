#!/usr/bin/env -S node --import tsx
import { main } from "./main.ts";

process.exitCode = await main();
