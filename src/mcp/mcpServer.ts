import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PipelineJobStatus } from "../pipeline/types";
import { type JobInfo, LibraryNotFoundError, VersionNotFoundError } from "../tools";
import { DEFAULT_MAX_DEPTH, DEFAULT_MAX_PAGES } from "../utils/config";
import { logger } from "../utils/logger";
import type { McpServerTools } from "./tools";
import { createError, createResponse } from "./utils";

/**
 * Creates and configures an instance of the MCP server with registered tools, prompts, and resources.
 * @param tools The shared tool instances to use for server operations.
 * @returns A configured McpServer instance.
 */
export function createMcpServerInstance(tools: McpServerTools): McpServer {
  const server = new McpServer(
    {
      name: "docs-mcp-server",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
        prompts: {},
        resources: {},
      },
    },
  );

  // --- Tool Definitions ---

  // Scrape docs tool
  server.tool(
    "scrape_docs",
    "Scrape and index documentation from a URL",
    {
      url: z.string().url().describe("URL of the documentation to scrape"),
      library: z.string().describe("Name of the library"),
      version: z.string().optional().describe("Version of the library"),
      maxPages: z
        .number()
        .optional()
        .default(DEFAULT_MAX_PAGES)
        .describe(`Maximum number of pages to scrape (default: ${DEFAULT_MAX_PAGES})`),
      maxDepth: z
        .number()
        .optional()
        .default(DEFAULT_MAX_DEPTH)
        .describe(`Maximum navigation depth (default: ${DEFAULT_MAX_DEPTH})`),
      scope: z
        .enum(["subpages", "hostname", "domain"])
        .optional()
        .default("subpages")
        .describe("Defines the crawling boundary: 'subpages', 'hostname', or 'domain'"),
      followRedirects: z
        .boolean()
        .optional()
        .default(true)
        .describe("Whether to follow HTTP redirects (3xx responses)"),
    },
    async ({ url, library, version, maxPages, maxDepth, scope, followRedirects }) => {
      try {
        // Execute scrape tool without waiting and without progress callback
        const result = await tools.scrape.execute({
          url,
          library,
          version,
          waitForCompletion: false, // Don't wait for completion
          // onProgress: undefined, // Explicitly undefined or omitted
          options: {
            maxPages,
            maxDepth,
            scope,
            followRedirects,
          },
        });

        // Check the type of result
        if ("jobId" in result) {
          // If we got a jobId back, report that
          return createResponse(`🚀 Scraping job started with ID: ${result.jobId}.`);
        }
        // This case shouldn't happen if waitForCompletion is false, but handle defensively
        return createResponse(
          `Scraping finished immediately (unexpectedly) with ${result.pagesScraped} pages.`,
        );
      } catch (error) {
        // Handle errors during job *enqueueing* or initial setup
        return createError(
          `Failed to scrape documentation: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
  );

  // Search docs tool
  server.tool(
    "search_docs",
    "Searches up-to-date documentation for a library. Examples:\n\n" +
      '- {library: "react", query: "hooks lifecycle"} -> matches latest version of React\n' +
      '- {library: "react", version: "18.0.0", query: "hooks lifecycle"} -> matches React 18.0.0 or earlier\n' +
      '- {library: "typescript", version: "5.x", query: "ReturnType example"} -> any TypeScript 5.x.x version\n' +
      '- {library: "typescript", version: "5.2.x", query: "ReturnType example"} -> any TypeScript 5.2.x version',
    {
      library: z.string().describe("Name of the library"),
      version: z
        .string()
        .optional()
        .describe(
          "Version of the library (supports exact versions like '18.0.0' or X-Range patterns like '5.x', '5.2.x')",
        ),
      query: z.string().describe("Search query"),
      limit: z.number().optional().default(5).describe("Maximum number of results"),
    },
    async ({ library, version, query, limit }) => {
      try {
        const result = await tools.search.execute({
          library,
          version,
          query,
          limit,
          exactMatch: false, // Always false for MCP interface
        });

        const formattedResults = result.results.map(
          (r: { url: string; content: string }, i: number) => `
------------------------------------------------------------
Result ${i + 1}: ${r.url}

${r.content}\n`,
        );

        if (formattedResults.length === 0) {
          return createResponse(
            `No results found for '${query}' in ${library}. Try to use a different or more general query.`,
          );
        }
        return createResponse(
          `Search results for '${query}' in ${library}:
${formattedResults.join("")}`,
        );
      } catch (error) {
        if (error instanceof LibraryNotFoundError) {
          return createResponse(
            [
              `Library "${library}" not found.`,
              error.suggestions?.length
                ? `Did you mean: ${error.suggestions?.join(", ")}?`
                : undefined,
            ].join(" "),
          );
        }
        if (error instanceof VersionNotFoundError) {
          const indexedVersions = error.availableVersions.map((v) => v.version);
          return createResponse(
            [
              `Version "${version}" not found.`,
              indexedVersions.length > 0
                ? `Available indexed versions for ${library}: ${indexedVersions.join(", ")}`
                : undefined,
            ].join(" "),
          );
        }
        return createError(
          `Failed to search documentation: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
  );

  // List libraries tool
  server.tool("list_libraries", "List all indexed libraries", {}, async () => {
    try {
      const result = await tools.listLibraries.execute();
      if (result.libraries.length === 0) {
        return createResponse("No libraries indexed yet.");
      }

      return createResponse(
        `Indexed libraries:\n\n${result.libraries.map((lib: { name: string }) => `- ${lib.name}`).join("\n")}`,
      );
    } catch (error) {
      return createError(
        `Failed to list libraries: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });

  // Find version tool
  server.tool(
    "find_version",
    "Find best matching version for a library",
    {
      library: z.string().describe("Name of the library"),
      targetVersion: z
        .string()
        .optional()
        .describe(
          "Pattern to match (supports exact versions like '18.0.0' or X-Range patterns like '5.x', '5.2.x')",
        ),
    },
    async ({ library, targetVersion }) => {
      try {
        const message = await tools.findVersion.execute({
          library,
          targetVersion,
        });

        if (!message) {
          return createError("No matching version found");
        }

        return createResponse(message);
      } catch (error) {
        return createError(
          `Failed to find version: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
  );

  // List jobs tool
  server.tool(
    "list_jobs",
    "List pipeline jobs, optionally filtering by status.",
    {
      status: z
        .nativeEnum(PipelineJobStatus)
        .optional()
        .describe("Optional status to filter jobs by."),
    },
    async ({ status }) => {
      try {
        const result = await tools.listJobs.execute({ status });
        // Format the simplified job list for display
        const formattedJobs = result.jobs
          .map(
            (job: JobInfo) =>
              `- ID: ${job.id}\n  Status: ${job.status}\n  Library: ${job.library}\n  Version: ${job.version}\n  Created: ${job.createdAt}${job.startedAt ? `\n  Started: ${job.startedAt}` : ""}${job.finishedAt ? `\n  Finished: ${job.finishedAt}` : ""}${job.error ? `\n  Error: ${job.error}` : ""}`,
          )
          .join("\n\n");
        return createResponse(
          result.jobs.length > 0 ? `Current Jobs:\n\n${formattedJobs}` : "No jobs found.",
        );
      } catch (error) {
        return createError(
          `Failed to list jobs: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
  );

  // Get job info tool
  server.tool(
    "get_job_info",
    "Get the simplified info for a specific pipeline job.",
    {
      jobId: z.string().uuid().describe("The ID of the job to query."),
    },
    async ({ jobId }) => {
      try {
        const result = await tools.getJobInfo.execute({ jobId });
        if (!result.job) {
          return createError(`Job with ID ${jobId} not found.`);
        }
        const job = result.job;
        const formattedJob = `- ID: ${job.id}\n  Status: ${job.status}\n  Library: ${job.library}@${job.version}\n  Created: ${job.createdAt}${job.startedAt ? `\n  Started: ${job.startedAt}` : ""}${job.finishedAt ? `\n  Finished: ${job.finishedAt}` : ""}${job.error ? `\n  Error: ${job.error}` : ""}`;
        return createResponse(`Job Info:\n\n${formattedJob}`);
      } catch (error) {
        return createError(
          `Failed to get job info for ${jobId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
  );

  // Fetch URL tool
  server.tool(
    "fetch_url",
    "Fetch a single URL and convert its content to Markdown",
    {
      url: z.string().url().describe("The URL to fetch and convert to markdown"),
      followRedirects: z
        .boolean()
        .optional()
        .default(true)
        .describe("Whether to follow HTTP redirects (3xx responses)"),
    },
    async ({ url, followRedirects }) => {
      try {
        const result = await tools.fetchUrl.execute({ url, followRedirects });
        return createResponse(result);
      } catch (error) {
        return createError(
          `Failed to fetch URL: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );

  // Cancel job tool
  server.tool(
    "cancel_job",
    "Attempt to cancel a queued or running pipeline job.",
    {
      jobId: z.string().uuid().describe("The ID of the job to cancel."),
    },
    async ({ jobId }) => {
      try {
        const result = await tools.cancelJob.execute({ jobId });
        // Use the message and success status from the tool's result
        if (result.success) {
          return createResponse(result.message);
        }
        // If not successful according to the tool, treat it as an error in MCP
        return createError(result.message);
      } catch (error) {
        // Catch any unexpected errors during the tool execution itself
        return createError(
          `Failed to cancel job ${jobId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
  );

  // Remove docs tool
  server.tool(
    "remove_docs",
    "Remove indexed documentation for a library version.",
    {
      library: z.string().describe("Name of the library"),
      version: z
        .string()
        .optional()
        .describe("Version of the library (optional, removes unversioned if omitted)"),
    },
    async ({ library, version }) => {
      try {
        // Execute the remove tool logic
        const result = await tools.remove.execute({ library, version });
        // Use the message from the tool's successful execution
        return createResponse(result.message);
      } catch (error) {
        // Catch errors thrown by the RemoveTool's execute method
        return createError(
          `Failed to remove documents: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
  );

  server.prompt(
    "docs",
    "Search indexed documentation",
    {
      library: z.string().describe("Name of the library"),
      version: z.string().optional().describe("Version of the library"),
      query: z.string().describe("Search query"),
    },
    async ({ library, version, query }) => {
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Please search ${library} ${version || ""} documentation for this query: ${query}`,
            },
          },
        ],
      };
    },
  );

  server.resource(
    "libraries",
    "docs://libraries",
    {
      description: "List all indexed libraries",
    },
    async (uri: URL) => {
      const result = await tools.listLibraries.execute();

      return {
        contents: result.libraries.map((lib: { name: string }) => ({
          uri: new URL(lib.name, uri).href,
          text: lib.name,
        })),
      };
    },
  );

  server.resource(
    "versions",
    new ResourceTemplate("docs://libraries/{library}/versions", {
      list: undefined,
    }),
    {
      description: "List all indexed versions for a library",
    },
    async (uri: URL, { library }) => {
      const result = await tools.listLibraries.execute();

      const lib = result.libraries.find((l: { name: string }) => l.name === library);
      if (!lib) {
        return { contents: [] };
      }

      return {
        contents: lib.versions.map((v: { version: string }) => ({
          uri: new URL(v.version, uri).href,
          text: v.version,
        })),
      };
    },
  );

  /**
   * Resource handler for listing pipeline jobs.
   * Supports filtering by status via a query parameter (e.g., ?status=running).
   * URI: docs://jobs[?status=<status>]
   */
  server.resource(
    "jobs",
    "docs://jobs",
    {
      description: "List pipeline jobs, optionally filtering by status.",
      mimeType: "application/json",
    },
    async (uri: URL) => {
      const statusParam = uri.searchParams.get("status");
      let statusFilter: PipelineJobStatus | undefined;

      // Validate status parameter if provided
      if (statusParam) {
        const validation = z.nativeEnum(PipelineJobStatus).safeParse(statusParam);
        if (validation.success) {
          statusFilter = validation.data;
        } else {
          // Handle invalid status - perhaps return an error or ignore?
          // For simplicity, let's ignore invalid status for now and return all jobs.
          // Alternatively, could throw an McpError or return specific error content.
          logger.warn(`Invalid status parameter received: ${statusParam}`);
        }
      }

      // Fetch simplified jobs using the ListJobsTool
      const result = await tools.listJobs.execute({ status: statusFilter });

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(result.jobs, null, 2), // Stringify the simplified jobs array
          },
        ],
      };
    },
  );

  /**
   * Resource handler for retrieving a specific pipeline job by its ID.
   * URI Template: docs://jobs/{jobId}
   */
  server.resource(
    "job", // A distinct name for this specific resource type
    new ResourceTemplate("docs://jobs/{jobId}", { list: undefined }),
    {
      description: "Get details for a specific pipeline job by ID.",
      mimeType: "application/json",
    },
    async (uri: URL, { jobId }) => {
      // Validate jobId format if necessary (basic check)
      if (typeof jobId !== "string" || jobId.length === 0) {
        // Handle invalid jobId format - return empty or error
        logger.warn(`Invalid jobId received in URI: ${jobId}`);
        return { contents: [] }; // Return empty content for invalid ID format
      }

      // Fetch the simplified job info using GetJobInfoTool
      const result = await tools.getJobInfo.execute({ jobId });

      // result.job is either the simplified job object or null
      if (!result.job) {
        // Job not found, return empty content
        return { contents: [] };
      }

      // Job found, return its simplified details as JSON
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(result.job, null, 2), // Stringify the simplified job object
          },
        ],
      };
    },
  );

  return server;
}
