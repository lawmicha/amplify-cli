import * as aws from 'aws-sdk';
import assert from 'assert';
import * as path from 'path';
import throttle from 'lodash.throttle';
import {
  createDeploymentMachine,
  DeploymentMachineOp,
  DeploymentMachineStep,
  StateMachineHelperFunctions,
  DeploymentMachineState,
} from './state-machine';
import { interpret, State } from 'xstate';
import { IStackProgressPrinter, StackEventMonitor } from './stack-event-monitor';
import { StackProgressPrinter } from './stack-progress-printer';
import ora from 'ora';
import configurationManager from '../configuration-manager';
import { $TSContext, DeploymentStatus, IDeploymentStateManager } from 'amplify-cli-core';
import { ConfigurationOptions } from 'aws-sdk/lib/config-base';
import { getBucketKey, getHttpUrl } from './helpers';
import { DeploymentStateManager } from './deployment-state-manager';
import { DeploymentStepStatus } from 'amplify-cli-core';
import { update } from 'lodash';

interface DeploymentManagerOptions {
  throttleDelay?: number;
  eventPollingDelay?: number;
}

export type DeploymentOp = Omit<DeploymentMachineOp, 'region' | 'stackTemplatePath' | 'stackTemplateUrl'> & {
  stackTemplatePathOrUrl: string;
};

export type DeploymentStep = {
  deployment: DeploymentOp;
  rollback: DeploymentOp;
};
export class DeploymentManager {
  /**
   * Helper method to get an instance of the Deployment manager with the right credentials
   */

  public static createInstance = async (
    context: $TSContext,
    deploymentBucket: string,
    spinner: ora.Ora,
    printer?: IStackProgressPrinter,
    options?: DeploymentManagerOptions,
  ) => {
    try {
      const cred = await configurationManager.loadConfiguration(context);
      assert(cred.region);
      return new DeploymentManager(cred, cred.region, deploymentBucket, spinner, printer, options);
    } catch (e) {
      throw new Error('Could not load the credentials');
    }
  };

  private deployment: DeploymentMachineStep[] = [];
  private options: Required<DeploymentManagerOptions>;
  private cfnClient: aws.CloudFormation;
  private s3Client: aws.S3;
  private constructor(
    creds: ConfigurationOptions,
    private region: string,
    private deploymentBucket: string,
    private spinner: ora.Ora,
    // private deployedTemplatePath: string,
    private printer: IStackProgressPrinter = new StackProgressPrinter(),
    options: DeploymentManagerOptions = {},
  ) {
    this.options = {
      throttleDelay: 1_000,
      eventPollingDelay: 1_000,
      ...options,
    };
    this.s3Client = new aws.S3(creds);
    this.cfnClient = new aws.CloudFormation(creds);
  }

  public deploy = async (deploymentStateManager: IDeploymentStateManager): Promise<void> => {
    // sanity check before deployment
    const deploymentTemplates = this.deployment.reduce<Set<string>>((acc, step) => {
      acc.add(step.deployment.stackTemplatePath);
      acc.add(step.rollback.stackTemplatePath);
      return acc;
    }, new Set());
    await Promise.all(Array.from(deploymentTemplates.values()).map(path => this.ensureTemplateExists(path)));

    const fns: StateMachineHelperFunctions = {
      deployFn: this.doDeploy,
      deploymentWaitFn: this.waitForDeployment,
      rollbackFn: this.rollBackStack,
      tableReadyWaitFn: this.waitForIndices,
      rollbackWaitFn: this.waitForDeployment,
      stackEventPollFn: this.stackPollFn,
    };
    const machine = createDeploymentMachine(
      {
        currentIndex: -1,
        deploymentBucket: this.deploymentBucket,
        region: this.region,
        stacks: this.deployment,
      },
      fns,
    );

    let maxDeployed = 0;
    return new Promise(async (resolve, reject) => {
      const service = interpret(machine)
        .onTransition(async state => {
          await this.updateDeploymentStatus(state, deploymentStateManager);
          if (state.changed) {
            maxDeployed = Math.max(maxDeployed, state.context.currentIndex + 1);
            if (state.matches('idle')) {
              this.spinner.text = `Starting deployment`;
            } else if (state.matches('deploy')) {
              this.spinner.text = `Deploying stack (${maxDeployed} of ${state.context.stacks.length})`;
            } else if (state.matches('rollback')) {
              this.spinner.text = `Rolling back (${maxDeployed - state.context.currentIndex} of ${maxDeployed})`;
            } else if (state.matches('deployed')) {
              this.spinner.succeed(`Deployed`);
            }
          }

          switch (state.value) {
            case 'deployed':
              return resolve();
            case 'rolledBack':
            case 'failed':
              return reject(new Error('Deployment failed'));
              break;
            default:
            // intentionally left blank as we don't care about intermediate states
          }
        })
        .start();
      service.send({ type: 'DEPLOY' });
    });
  };

  public addStep = (deploymentStep: DeploymentStep): void => {
    const deploymentStackTemplateUrl = getHttpUrl(deploymentStep.deployment.stackTemplatePathOrUrl, this.deploymentBucket);
    const deploymentStackTemplatePath = getBucketKey(deploymentStep.deployment.stackTemplatePathOrUrl, this.deploymentBucket);

    const rollbackStackTemplateUrl = getHttpUrl(deploymentStep.rollback.stackTemplatePathOrUrl, this.deploymentBucket);
    const rollbackStackTemplatePath = getBucketKey(deploymentStep.rollback.stackTemplatePathOrUrl, this.deploymentBucket);

    this.deployment.push({
      deployment: {
        ...deploymentStep.deployment,
        stackTemplatePath: deploymentStackTemplatePath,
        stackTemplateUrl: deploymentStackTemplateUrl,
        region: this.region,
        clientRequestToken: deploymentStep.deployment.clientRequestToken
          ? `deploy-${deploymentStep.deployment.clientRequestToken}`
          : undefined,
      },
      rollback: {
        ...deploymentStep.rollback,
        stackTemplatePath: rollbackStackTemplatePath,
        stackTemplateUrl: rollbackStackTemplateUrl,
        region: this.region,
        clientRequestToken: deploymentStep.rollback.clientRequestToken
          ? `rollback-${deploymentStep.rollback.clientRequestToken}`
          : undefined,
      },
    });
  };

  public setPrinter = (printer: IStackProgressPrinter) => {
    this.printer = printer;
  };

  /**
   * Ensure that the stack is present and can be deployed
   * @param stackName name of the stack
   */
  private ensureStack = async (stackName: string): Promise<boolean> => {
    const result = await this.cfnClient.describeStacks({ StackName: stackName }).promise();
    return result.Stacks[0].StackStatus.endsWith('_COMPLETE');
  };

  /**
   * Checks the file exists in the path
   * @param templatePath path of the cloudformation file
   */
  private ensureTemplateExists = async (templatePath: string): Promise<boolean> => {
    let key = templatePath;
    try {
      const bucketKey = getBucketKey(templatePath, this.deploymentBucket);
      await this.s3Client.headObject({ Bucket: this.deploymentBucket, Key: bucketKey }).promise();
      return true;
    } catch (e) {
      if (e.ccode === 'NotFound') {
        throw new Error(`The cloudformation template ${templatePath} was not found in deployment bucket ${this.deploymentBucket}`);
      }
      throw e;
    }
  };

  private getTableStatus = async (tableName: string, region: string): Promise<boolean> => {
    assert(tableName, 'table name should be passed');
    const dbClient = new aws.DynamoDB({ region });
    try {
      const response = await dbClient.describeTable({ TableName: tableName }).promise();
      const gsis = response.Table?.GlobalSecondaryIndexes;
      return gsis ? gsis.every(idx => idx.IndexStatus === 'ACTIVE') : true;
    } catch (e) {
      throw e;
    }
  };

  private waitForIndices = async (stackParams: DeploymentMachineOp) => {
    if (stackParams.tableNames.length) console.log('\nWaiting for DynamoDB table indices to be ready');
    const throttledGetTableStatus = throttle(this.getTableStatus, this.options.throttleDelay);

    const waiters = stackParams.tableNames.map(name => {
      return new Promise(resolve => {
        let interval = setInterval(async () => {
          const areIndexesReady = await throttledGetTableStatus(name, this.region);
          if (areIndexesReady) {
            clearInterval(interval);
            resolve(undefined);
          }
        }, this.options.throttleDelay);
      });
    });

    try {
      await Promise.all(waiters);
      return Promise.resolve();
    } catch (e) {
      Promise.reject(e);
    }
  };

  private stackPollFn = (deploymentStep: DeploymentMachineOp): (() => void) => {
    let monitor: StackEventMonitor;
    assert(deploymentStep.stackName, 'stack name should be passed to stackPollFn');
    if (this.printer) {
      monitor = new StackEventMonitor(this.cfnClient, deploymentStep.stackName, this.printer);
      monitor.start();
    }
    return () => {
      if (monitor) {
        monitor.stop();
      }
    };
  };

  private doDeploy = async (currentStack: DeploymentMachineOp): Promise<void> => {
    const cfn = this.cfnClient;
    assert(currentStack.stackName, 'stack name should be passed to doDeploy');
    assert(currentStack.stackTemplateUrl, 'stackTemplateUrl must be passed to doDeploy');
    await this.ensureStack(currentStack.stackName);
    const parameters = Object.entries(currentStack.parameters).map(([key, val]) => {
      return {
        ParameterKey: key,
        ParameterValue: val.toString(),
      };
    });
    try {
      await cfn
        .updateStack({
          StackName: currentStack.stackName,
          Parameters: parameters,
          TemplateURL: currentStack.stackTemplateUrl,
          Capabilities: currentStack.capabilities,
          ClientRequestToken: currentStack.clientRequestToken,
        })
        .promise();
    } catch (e) {
      return Promise.reject(e);
    }
  };

  private waitForDeployment = async (stackParams: DeploymentMachineOp): Promise<void> => {
    const cfnClient = this.cfnClient;
    assert(stackParams.stackName, 'stackName should be passed to waitForDeployment');
    try {
      await cfnClient
        .waitFor('stackUpdateComplete', {
          StackName: stackParams.stackName,
        })
        .promise();
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(e);
    }
  };

  private rollBackStack = async (currentStack: Readonly<DeploymentMachineOp>): Promise<void> => {
    await this.doDeploy(currentStack);
  };

  private updateDeploymentStatus = async (
    machineState: DeploymentMachineState,
    deploymentStateManager: IDeploymentStateManager,
  ): Promise<void> => {
    if (machineState.changed) {
      if (machineState.value === 'rollback' && machineState.history?.matches('deploy')) {
        deploymentStateManager.startRollback();
      } else if (machineState.matches('deploy.triggerDeploy')) {
        if (!machineState.history?.matches('idle')) {
          if (machineState.context.currentIndex < machineState.context.stacks.length - 1) {
            await deploymentStateManager.advanceStep(DeploymentStepStatus.DEPLOYED);
          } else {
            await deploymentStateManager.updateCurrentStepStatus(DeploymentStepStatus.DEPLOYED);
          }
        }
      } else if (machineState.matches('rollback.triggerRollback')) {
        if (machineState.context.currentIndex > 0) {
          await deploymentStateManager.advanceStep(DeploymentStepStatus.ROLLED_BACK);
        } else {
          await deploymentStateManager.updateCurrentStepStatus(DeploymentStepStatus.ROLLED_BACK);
        }
      } else if (machineState.matches('deploy.waitingForDeployment')) {
        await deploymentStateManager.updateCurrentStepStatus(DeploymentStepStatus.DEPLOYING);
      } else if (machineState.matches('deploy.waitForTablesToBeReady') || machineState.matches('rollback.waitForTablesToBeReady')) {
        await deploymentStateManager.updateCurrentStepStatus(DeploymentStepStatus.WAITING_FOR_TABLE_TO_BE_READY);
      } else if (machineState.matches('rollback.waitingForRollback')) {
        await deploymentStateManager.updateCurrentStepStatus(DeploymentStepStatus.WAITING_FOR_ROLLBACK);
      } else if (machineState.matches('deployed')) {
        await deploymentStateManager.finishDeployment(DeploymentStatus.DEPLOYED);
      } else if (machineState.matches('rolledBack')) {
        await deploymentStateManager.finishDeployment(DeploymentStatus.ROLLED_BACK);
      } else if (machineState.matches('failed')) {
        await deploymentStateManager.finishDeployment(DeploymentStatus.FAILED);
      }
    }
  };
}
