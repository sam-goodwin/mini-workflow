import yargs from "yargs";
import type { Argv } from "yargs";
import { hideBin } from "yargs/helpers";
import { replay } from "./replay";
import { AWSRuntime } from "./aws";
import { LocalRuntime } from "./local";

yargs(hideBin(process.argv))
  .command(
    "replay",
    "Replay a workflow execution",
    (yargs) => {
      return yargs
        .option("main", {
          type: "string",
          demandOption: true,
          describe: "Path to the main script to be imported",
        })
        .option("bucket-name", {
          type: "string",
          demandOption: true,
          describe: "S3 bucket name for AWS runtime",
        })
        .option("execution-id", {
          type: "string",
          demandOption: true,
          describe: "Execution ID to replay",
        })
        .option("object-prefix", {
          type: "string",
          default: "executions/",
          describe: "S3 object prefix for AWS runtime",
        });
    },
    async (argv) => {
      await replay({
        main: argv.main,
        executionId: argv.executionId,
        runtime: new AWSRuntime({
          bucketName: argv.bucketName,
          objectPrefix: argv.objectPrefix,
          fifoQueueUrl: undefined,
          fifoQueueArn: undefined,
        }),
      });
    },
  )
  .command(
    "ls",
    "List workflow executions",
    (yargs) => {
      return awsRuntimeOptions(
        yargs.option("workflow-name", {
          type: "string",
          demandOption: false,
          describe: "Workflow name to list executions for (optional)",
        }),
      );
    },
    async (argv) => {
      const runtime = new AWSRuntime({
        bucketName: argv.bucketName,
        objectPrefix: argv.objectPrefix,
        fifoQueueUrl: undefined,
        fifoQueueArn: undefined,
      });

      const executionIds = await runtime.listExecutions({
        workflowName: argv.workflowName,
      });
      console.log(executionIds.join("\n"));
    },
  )
  .command(
    "get",
    "Display workflow execution history",
    (yargs) => {
      return awsRuntimeOptions(
        yargs
          .option("execution-id", {
            type: "string",
            demandOption: true,
            describe: "Execution ID to display history for",
          })
          .option("workflow-name", {
            type: "string",
            demandOption: false,
            describe: "Workflow name to display history for",
          })
          .option("json", {
            type: "boolean",
            default: false,
            describe: "Output history as JSON",
          })
          .option("lines", {
            type: "boolean",
            default: false,
            describe: "Output history as lines",
          }),
      );
    },
    async (argv) => {
      const runtime = new AWSRuntime({
        bucketName: argv.bucketName,
        objectPrefix: argv.objectPrefix,
        fifoQueueUrl: undefined,
        fifoQueueArn: undefined,
      });

      try {
        const history = await runtime.getHistory(argv.executionId);
        if (argv.lines) {
          console.log(`Workflow: ${argv.executionId.split(":")[0]}`);
          console.log(`Execution ID: ${argv.executionId}`);
          history.events.forEach((event) => {
            if (!argv.json) {
              if (event.kind === "request") {
                if (event.type === "sleep") {
                  console.log(
                    `${event.seq}: sleep(${event.seconds} second${
                      event.seconds === 1 ? "" : "s"
                    })`,
                  );
                } else if (event.type === "task") {
                  console.log(`${event.seq}: task()`);
                }
              } else {
                if (event.type === "sleep") {
                  console.log(`${event.seq}: sleep @${event.replyTo} elapsed`);
                } else if (event.type === "task") {
                  console.log(
                    `${event.seq}: task ${event.replyTo} completed with ${event.result.error ? "error" : "output"}: ${event.result.error ? event.result.error : event.result.value}`,
                  );
                }
              }
            } else {
              console.log(JSON.stringify(event));
            }
          });
        } else if (argv.json) {
          console.log(JSON.stringify(history, null, 2));
        } else {
          console.log(history);
        }
      } catch (error) {
        console.error(`Error retrieving execution history: ${error}`);
        process.exit(1);
      }
    },
  )
  .demandCommand(1, "You need to specify a command")
  .help().argv;

function awsRuntimeOptions<Opts>(yargs: Argv<Opts>) {
  return yargs
    .option("bucket-name", {
      type: "string",
      demandOption: true,
      describe: "S3 bucket name for AWS runtime",
    })
    .option("object-prefix", {
      type: "string",
      default: "executions/",
      describe: "S3 object prefix for AWS runtime",
    });
}
