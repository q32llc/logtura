/** Real loopback HTTP with a dedicated socket and no automatic retries. */
export declare function localHttpFetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
