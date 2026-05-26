# mule-app-analyzer

## Overview
This is a node.js application.
This app is to analyze MuleSoft applications.
Eventually, it will support all types of deployment options - CloudHub 1.0, CloudHub 2.0, Hybrid and RTF etc.
At this stage, the app supports CloudHub 1.0

## Prerequisation
1. Create a Connected App in Anypoint Platform, and assign it following permissions:
- Runtime Manager: Download Applications
- Runtime Manager: Read Applications
2. Note the Connected App's Client ID and Client Secret

## CloudHub 1.0 Workflow
1. Get Access Token
Call POST method to the following API to get the access token:

```
https://anypoint.mulesoft.com/accounts/api/v2/oauth2/token
```

The request payload is:
```json
{
    "client_id": "{{connected_app_client_id}}",
    "client_secret": "{{connected_app_client_secret}}",
    "grant_type": "client_credentials"
}
```

Both {{connected_app_client_id}} and {{connected_app_client_secret}} are passed to the application when running the app. For example:
`
node mule-app-analyzer client_id client_secret
`

The API response is like below:
```json
{
    "access_token": "2cd9e3b2-55c6-4c2c-9c89-87cf61d9c4ee",
    "expires_in": 2212,
    "token_type": "bearer"
}
```

The "access_token" will be used for all following APIs.

2. Get List of Applications
Call GET method to the following API to get the list of applications:

```
https://anypoint.mulesoft.com/cloudhub/api/v2/applications
```

The sample response. It returns 2 applications:

```json
[
    {
        "versionId": "6a14f663bfcad56ed4042c15",
        "domain": "test-sf-connector-app123",
        ...
        "lastUpdateTime": 1779758843024,
        "fileName": "test-message-logging.jar",
        ...
    },
    {
        "versionId": "6a153d00341d863350ea6432",
        "domain": "test-jms-consumer-app",
        ...
        "fileName": "demo-otlp-jms-consumer.jar",
        ...
    }
]
```

We're only interested in the "domain" and "fileName". Both will be used for the next step.

3. Download Application's .jar File
Loop each application returned from Step 2 and note the "domain" and "fileName".

Call GET method to the following API and replace {{domain}} and {{fileName}}:

```
https://anypoint.mulesoft.com/cloudhub/api/applications/{{domain}}/download/{{fileName}}
```

The API will download the applicaiton's .jar file, please save the downloaded .jar file into the folder "mule-apps".