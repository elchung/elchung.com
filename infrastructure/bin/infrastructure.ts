import { App } from "aws-cdk-lib";
import { BuildStack } from "../lib/infrastructure-stack";


const env = {
  account: "278863842127",
  region: "us-west-2",
};

const app = new App();

new BuildStack(app, 'infraBuildStack', { env });

app.synth();