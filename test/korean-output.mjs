process.env.WAX_LANG = 'ko';

const configs = [['maintenance.auto', 'false'], ['gc.auto', '0']];
const start = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
configs.forEach(([key, value], index) => { process.env[`GIT_CONFIG_KEY_${start + index}`] = key; process.env[`GIT_CONFIG_VALUE_${start + index}`] = value; });
process.env.GIT_CONFIG_COUNT = String(start + configs.length);
