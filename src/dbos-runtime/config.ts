import { DBOSInitializationError } from '../error';
import { DBOSJSON, globalParams, readFileSync } from '../utils';
import { DBOSConfig } from '../dbos-executor';
import { PoolConfig } from 'pg';
import YAML from 'yaml';
import { DBOSRuntimeConfig, defaultEntryPoint } from './runtime';
import { UserDatabaseName } from '../user_database';
import { TelemetryConfig } from '../telemetry';
import { writeFileSync } from 'fs';
import Ajv, { ValidateFunction } from 'ajv';
import path from 'path';
import validator from 'validator';
import fs from 'fs';
import { loadDatabaseConnection } from './db_connection';
import { GlobalLogger } from '../telemetry/logs';
import dbosConfigSchema from '../../dbos-config.schema.json';

export const dbosConfigFilePath = 'dbos-config.yaml';
const ajv = new Ajv({ allErrors: true, verbose: true });

export interface ConfigFile {
  name?: string;
  language?: string;
  database: {
    hostname?: string;
    port?: number;
    username?: string;
    password?: string;
    connectionTimeoutMillis?: number;
    app_db_name?: string;
    sys_db_name?: string;
    ssl?: boolean;
    ssl_ca?: string;
    app_db_client?: UserDatabaseName;
    migrate?: string[];
    rollback?: string[];
    local_suffix?: boolean;
  };
  http?: {
    cors_middleware?: boolean;
    credentials?: boolean;
    allowed_origins?: string[];
  };
  telemetry?: TelemetryConfig;
  application: object;
  env: Record<string, string>;
  runtimeConfig?: DBOSRuntimeConfig;
}

/*
 * Substitute environment variables using a regex for matching.
 * Will find anything in curly braces.
 * TODO: Use a more robust solution.
 */
export function substituteEnvVars(content: string): string {
  const regex = /\${([^}]+)}/g; // Regex to match ${VAR_NAME} style placeholders
  return content.replace(regex, (_, g1: string) => {
    return process.env[g1] || '""'; // If the env variable is not set, return an empty string.
  });
}

/**
 * Loads config file as a ConfigFile.
 * @param {string} configFilePath - The path to the config file to be loaded.
 * @returns
 */
export function loadConfigFile(configFilePath: string): ConfigFile {
  try {
    const configFileContent = readFileSync(configFilePath);
    const interpolatedConfig = substituteEnvVars(configFileContent);
    const configFile = YAML.parse(interpolatedConfig) as ConfigFile;
    if (!configFile.database) {
      configFile.database = {}; // Create an empty database object if it doesn't exist
    }
    return configFile;
  } catch (e) {
    if (e instanceof Error) {
      throw new DBOSInitializationError(`Failed to load config from ${configFilePath}: ${e.message}`);
    } else {
      throw e;
    }
  }
}

/**
 * Writes a YAML.Document object to configFilePath.
 * @param {YAML.Document} configFile - The config file to be written.
 * @param {string} configFilePath - The path to the config file to be written to.
 */
export function writeConfigFile(configFile: YAML.Document, configFilePath: string) {
  try {
    const configFileContent = configFile.toString();
    writeFileSync(configFilePath, configFileContent);
  } catch (e) {
    if (e instanceof Error) {
      throw new DBOSInitializationError(`Failed to write config to ${configFilePath}: ${e.message}`);
    } else {
      throw e;
    }
  }
}

export function retrieveApplicationName(configFile: ConfigFile): string {
  let appName = configFile.name;
  if (appName !== undefined) {
    return appName;
  }
  const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json')).toString()) as {
    name: string;
  };
  appName = packageJson.name;
  if (appName === undefined) {
    throw new DBOSInitializationError(
      'Error: cannot find a valid package.json file. Please run this command in an application root directory.',
    );
  }
  return appName;
}

export function constructPoolConfig(configFile: ConfigFile, cliOptions?: ParseOptions) {
  // Load database connection parameters. If they're not in dbos-config.yaml, load from .dbos/db_connection. Else, use defaults.
  const databaseConnection = loadDatabaseConnection();
  if (!cliOptions?.silent) {
    const logger = new GlobalLogger();
    if (process.env.DBOS_DBHOST) {
      logger.info('Loading database connection parameters from debug environment variables');
    } else if (configFile.database.hostname) {
      logger.info('Loading database connection parameters from dbos-config.yaml');
    } else if (databaseConnection.hostname) {
      logger.info('Loading database connection parameters from .dbos/db_connection');
    } else {
      logger.info('Using default database connection parameters');
    }
  }
  configFile.database.hostname =
    process.env.DBOS_DBHOST || configFile.database.hostname || databaseConnection.hostname || 'localhost';
  const dbos_dbport = process.env.DBOS_DBPORT ? parseInt(process.env.DBOS_DBPORT) : undefined;
  configFile.database.port = dbos_dbport || configFile.database.port || databaseConnection.port || 5432;
  configFile.database.username =
    process.env.DBOS_DBUSER || configFile.database.username || databaseConnection.username || 'postgres';
  configFile.database.password =
    process.env.DBOS_DBPASSWORD ||
    configFile.database.password ||
    databaseConnection.password ||
    process.env.PGPASSWORD ||
    'dbos';
  const dbos_dblocalsuffix = process.env.DBOS_DBLOCALSUFFIX ? process.env.DBOS_DBLOCALSUFFIX === 'true' : undefined;
  configFile.database.local_suffix =
    dbos_dblocalsuffix ?? configFile.database.local_suffix ?? databaseConnection.local_suffix ?? false;

  let databaseName: string | undefined = configFile.database.app_db_name;
  if (databaseName === undefined) {
    const appName = retrieveApplicationName(configFile);
    databaseName = appName.toLowerCase().replaceAll('-', '_');
    if (databaseName.match(/^\d/)) {
      databaseName = '_' + databaseName; // Append an underscore if the name starts with a digit
    }
  }
  databaseName = configFile.database.local_suffix === true ? `${databaseName}_local` : databaseName;
  const poolConfig: PoolConfig = {
    host: configFile.database.hostname,
    port: configFile.database.port,
    user: configFile.database.username,
    password: configFile.database.password,
    connectionTimeoutMillis: configFile.database.connectionTimeoutMillis || 3000,
    database: databaseName,
  };

  if (!poolConfig.database) {
    throw new DBOSInitializationError(
      `DBOS configuration (${dbosConfigFilePath}) does not contain application database name`,
    );
  }

  // Details on Postgres SSL/TLS modes: https://www.postgresql.org/docs/current/libpq-ssl.html#LIBPQ-SSL-PROTECTION
  if (configFile.database.ssl === false) {
    // If SSL is set to false, do not use TLS
    poolConfig.ssl = false;
  } else if (configFile.database.ssl_ca) {
    // If an SSL certificate is provided, connect to Postgres using TLS and verify the server certificate. (equivalent to verify-full)
    poolConfig.ssl = { ca: [readFileSync(configFile.database.ssl_ca)], rejectUnauthorized: true };
  } else if (
    configFile.database.ssl === undefined &&
    (poolConfig.host === 'localhost' || poolConfig.host === '127.0.0.1')
  ) {
    // For local development only, do not use TLS unless it is specifically asked for (to support Dockerized Postgres, which does not support SSL connections)
    poolConfig.ssl = false;
  } else {
    // Otherwise, connect to Postgres using TLS but do not verify the server certificate. (equivalent to require)
    poolConfig.ssl = { rejectUnauthorized: false };
  }
  return poolConfig;
}

function prettyPrintAjvErrors(validate: ValidateFunction<unknown>) {
  return validate
    .errors!.map((error) => {
      let message = `Error: ${error.message}`;
      if (error.schemaPath) message += ` (schema path: ${error.schemaPath})`;
      if (error.params && error.keyword === 'additionalProperties') {
        message += `; the additional property '${error.params.additionalProperty}' is not allowed`;
      }
      if (error.data && error.keyword === 'not') {
        message += `; the value ${DBOSJSON.stringify(error.data)} is not allowed for field ${error.instancePath}`;
      }
      return message;
    })
    .join(', ');
}

export interface ParseOptions {
  port?: number;
  loglevel?: string;
  configfile?: string;
  appDir?: string;
  appVersion?: string | boolean;
  silent?: boolean;
  forceConsole?: boolean;
}

/*
 * Parse `dbosConfigFilePath` and return DBOSConfig and DBOSRuntimeConfig
 * Considers DBOSCLIStartOptions if provided, which takes precedence over config file
 * */
export function parseConfigFile(cliOptions?: ParseOptions): [DBOSConfig, DBOSRuntimeConfig] {
  if (cliOptions?.appDir) {
    process.chdir(cliOptions.appDir);
  }
  const configFilePath = cliOptions?.configfile ?? dbosConfigFilePath;
  const configFile: ConfigFile | undefined = loadConfigFile(configFilePath);
  if (!configFile) {
    throw new DBOSInitializationError(`DBOS configuration file ${configFilePath} is empty`);
  }

  if (configFile.database.local_suffix === true && configFile.database.hostname === 'localhost') {
    throw new DBOSInitializationError(
      `Invalid configuration (${configFilePath}): local_suffix may only be true when connecting to remote databases, not to localhost`,
    );
  }

  const schemaValidator = ajv.compile(dbosConfigSchema);
  if (!schemaValidator(configFile)) {
    const errorMessages = prettyPrintAjvErrors(schemaValidator);
    throw new DBOSInitializationError(`${configFilePath} failed schema validation. ${errorMessages}`);
  }

  if (configFile.language && configFile.language !== 'node') {
    throw new DBOSInitializationError(`${configFilePath} specifies invalid language ${configFile.language}`);
  }

  /*******************************/
  /* Handle user database config */
  /*******************************/

  const poolConfig = constructPoolConfig(configFile, cliOptions);

  if (!isValidDBname(poolConfig.database!)) {
    throw new DBOSInitializationError(
      `${configFilePath} specifies invalid app_db_name ${configFile.database.app_db_name}. Must be between 3 and 31 characters long and contain only lowercase letters, underscores, and digits (cannot begin with a digit).`,
    );
  }

  /***************************/
  /* Handle telemetry config */
  /***************************/

  // Consider CLI --loglevel and forceConsole flags
  if (cliOptions?.loglevel) {
    configFile.telemetry = {
      ...configFile.telemetry,
      logs: { ...configFile.telemetry?.logs, logLevel: cliOptions.loglevel },
    };
  }
  if (cliOptions?.forceConsole) {
    configFile.telemetry = {
      ...configFile.telemetry,
      logs: { ...configFile.telemetry?.logs, forceConsole: cliOptions.forceConsole },
    };
  }

  /************************************/
  /* Build final DBOS configuration */
  /************************************/
  globalParams.appVersion = getAppVersion(cliOptions?.appVersion);
  const dbosConfig: DBOSConfig = {
    poolConfig: poolConfig,
    userDbclient: configFile.database.app_db_client || UserDatabaseName.KNEX,
    telemetry: configFile.telemetry || undefined,
    system_database: configFile.database.sys_db_name ?? `${poolConfig.database}_dbos_sys`,
    application: configFile.application || undefined,
    env: configFile.env || {},
    http: configFile.http,
  };

  /*************************************/
  /* Build final runtime Configuration */
  /*************************************/
  const entrypoints = new Set<string>();
  if (configFile.runtimeConfig?.entrypoints) {
    configFile.runtimeConfig.entrypoints.forEach((entry) => entrypoints.add(entry));
  } else {
    entrypoints.add(defaultEntryPoint);
  }

  const appPort = Number(cliOptions?.port) || Number(configFile.runtimeConfig?.port) || 3000;
  const runtimeConfig: DBOSRuntimeConfig = {
    entrypoints: [...entrypoints],
    port: appPort,
    admin_port: Number(configFile.runtimeConfig?.admin_port) || appPort + 1,
    start: configFile.runtimeConfig?.start || [],
    setup: configFile.runtimeConfig?.setup || [],
  };

  return [dbosConfig, runtimeConfig];
}

function getAppVersion(appVersion: string | boolean | undefined) {
  if (typeof appVersion === 'string') {
    return appVersion;
  }
  if (appVersion === false) {
    return '';
  }
  return process.env.DBOS__APPVERSION || '';
}

function isValidDBname(dbName: string): boolean {
  if (dbName.length < 1 || dbName.length > 63) {
    return false;
  }
  if (dbName.match(/^\d/)) {
    // Cannot start with a digit
    return false;
  }
  return validator.matches(dbName, '^[a-z0-9_]+$');
}
