import { ConfigService } from '@nestjs/config';
import { DataSource, DataSourceOptions } from 'typeorm';
import configuration from '../config/configuration';
import * as path from 'path';
import { config } from 'dotenv';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';

// Load environment variables from the appropriate .env file
const nodeEnv = process.env.NODE_ENV ?? '';
const envPath = path.resolve(
  process.cwd(),
  `.env${nodeEnv == 'production' || nodeEnv == '' ? '' : '.'}${nodeEnv != 'production' ? nodeEnv : ''}`,
);
config({ path: envPath });

const configObject = configuration();

/**
 * Full options (globbed entities/migrations). Used by the TypeORM CLI
 * (`npm run migration:*`) and the seed data source, which run through
 * ts-node and therefore need the `.ts` variants in the globs.
 */
export const dataSourceOptions: DataSourceOptions = {
  type: configObject.database.type,
  host: configObject.database.host,
  port: configObject.database.port,
  username: configObject.database.username,
  password: configObject.database.password as any,
  database: configObject.database.name,
  entities: [path.join(__dirname, '..', 'database', 'entities', '*.entity.{ts,js}')],
  migrations: [path.join(__dirname, '..', 'database', 'migrations', '*.{ts,js}')],
  synchronize: configObject.database.synchronize,
};

// For migrations, export the DataSource directly
const AppDataSource = new DataSource(dataSourceOptions);
export default AppDataSource;

/**
 * Options for `TypeOrmModule.forRootAsync` in the application.
 *
 * Entities are registered through `TypeOrmModule.forFeature` in the feature
 * modules and picked up via `autoLoadEntities`; forcing filesystem globs here
 * would make TypeORM `require()` raw `.ts` files, which breaks under Vitest
 * (and duplicates what `forFeature` already registers).
 */
export const moduleOptions = async (configService: ConfigService): Promise<TypeOrmModuleOptions> => {
  return {
    type: configService.get<any>('database.type'),
    host: configService.get<string>('database.host'),
    port: configService.get<number>('database.port'),
    username: configService.get<string>('database.username'),
    password: configService.get<string>('database.password'),
    database: configService.get<string>('database.name'),

    autoLoadEntities: configService.get<boolean>('database.autoload'),
    // Migration classes are only needed when `migrationsRun` is enabled.
    // Under Vitest the glob would make TypeORM require() raw `.ts` files,
    // so it is emptied there (the CLI keeps its own globbed config above).
    migrations: process.env.VITEST
      ? []
      : [path.join(__dirname, '..', 'database', 'migrations', '*.{ts,js}')],

    synchronize: configService.get<boolean>('database.synchronize'),
    logging: configService.get<boolean>('database.logging') === true,
    migrationsRun: configService.get<boolean>('database.runMigrationsOnStart') === true,
  };
};
