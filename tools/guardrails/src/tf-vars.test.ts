import { describe, expect, test } from 'vitest';

interface TfVarsModule {
  tfVarsFromRepoVars: (json: string) => { name: string; value: string }[];
  TfVarsError: new (message: string) => Error;
}

// Loaded dynamically with a declared shape, so the file lints before tf-vars.ts exists.
const { TfVarsError, tfVarsFromRepoVars } = (await import('./tf-vars.ts')) as TfVarsModule;

// Spec 035, section 1: Terraform inputs for CI come from repository Actions variables named
// TF_VAR_<NAME>. Pure module; the CLI around it is covered by tf-vars.cli.test.ts.

/** The message of the error thrown by `fn`, after checking it is a TfVarsError. */
function failureOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(TfVarsError);
    return (error as Error).message;
  }
  throw new Error('expected a TfVarsError, but nothing was thrown');
}

describe('AC-1: TF_VAR_ keys become lowercase TF_VAR_ names, sorted', () => {
  test('AC-1: TF_VAR_DOMAIN_NAME gives TF_VAR_domain_name and other keys are ignored', () => {
    expect(tfVarsFromRepoVars('{"TF_VAR_DOMAIN_NAME":"a.example.com","OTHER":"x"}')).toEqual([
      { name: 'TF_VAR_domain_name', value: 'a.example.com' },
    ]);
  });

  test('AC-1: results are sorted by output name, not by input order or by the original key', () => {
    const json = JSON.stringify({
      TF_VAR_ZONE: 'z',
      tf_var_alpha: 'a',
      TF_VAR_MID: 'm',
    });
    expect(tfVarsFromRepoVars(json).map((entry) => entry.name)).toEqual([
      'TF_VAR_alpha',
      'TF_VAR_mid',
      'TF_VAR_zone',
    ]);
  });

  test('AC-1: a lowercase key tf_var_x is accepted and gives TF_VAR_x', () => {
    expect(tfVarsFromRepoVars('{"tf_var_x":"1"}')).toEqual([{ name: 'TF_VAR_x', value: '1' }]);
  });

  test('AC-1: the prefix is matched in any case', () => {
    expect(tfVarsFromRepoVars('{"Tf_Var_Mixed_Case":"1"}')).toEqual([
      { name: 'TF_VAR_mixed_case', value: '1' },
    ]);
  });

  test('AC-1: the rest of the name keeps its digits and underscores', () => {
    expect(tfVarsFromRepoVars('{"TF_VAR_A_1_B2":"v"}')).toEqual([
      { name: 'TF_VAR_a_1_b2', value: 'v' },
    ]);
  });

  test('AC-1: keys without the TF_VAR_ prefix are ignored, whatever their shape', () => {
    const json = JSON.stringify({ 'my-var': 'x', TFVAR_X: 'y', TF_VAR: 'z', XTF_VAR_A: 'w' });
    expect(tfVarsFromRepoVars(json)).toEqual([]);
  });

  test('AC-1: values are passed through unchanged (spaces and = signs stay)', () => {
    expect(tfVarsFromRepoVars('{"TF_VAR_LABEL":" a=b c "}')).toEqual([
      { name: 'TF_VAR_label', value: ' a=b c ' },
    ]);
  });
});

describe('AC-2: nothing to export', () => {
  test.each([
    ['the empty string', ''],
    ['the JSON null', 'null'],
    ['an empty object', '{}'],
  ])('AC-2: %s gives an empty list', (_label, json) => {
    expect(tfVarsFromRepoVars(json)).toEqual([]);
  });

  test('AC-2: an object with only unrelated keys gives an empty list', () => {
    expect(tfVarsFromRepoVars('{"SOMETHING":"x"}')).toEqual([]);
  });
});

describe('AC-3: input that is not an object of strings', () => {
  test.each([
    ['invalid JSON', '{'],
    ['text that is not JSON', 'not json'],
    ['a JSON array', '["TF_VAR_A"]'],
    ['an empty JSON array', '[]'],
    ['a JSON string', '"TF_VAR_A"'],
    ['a JSON number', '1'],
    ['a number value', '{"TF_VAR_A":1}'],
    ['a boolean value', '{"TF_VAR_A":true}'],
    ['a null value', '{"TF_VAR_A":null}'],
    ['an object value', '{"TF_VAR_A":{"b":"c"}}'],
    ['a non-string value under an ignored key', '{"OTHER":1}'],
  ])('AC-3: %s throws TfVarsError', (_label, json) => {
    expect(() => tfVarsFromRepoVars(json)).toThrow(TfVarsError);
  });
});

describe('AC-4: variable names', () => {
  test.each([
    ['an empty name', 'TF_VAR_'],
    ['a name that starts with a digit', 'TF_VAR_1X'],
    ['a name that starts with an underscore', 'TF_VAR__X'],
    ['a name with a dash', 'TF_VAR_A-B'],
    ['a name with a dot', 'TF_VAR_A.B'],
    ['a name with a space', 'TF_VAR_A B'],
  ])('AC-4: %s throws and the message names the key', (_label, key) => {
    const message = failureOf(() => tfVarsFromRepoVars(JSON.stringify({ [key]: 'v' })));
    expect(message).toContain(key);
  });

  test('AC-4: a bad key throws even when a good key is next to it', () => {
    expect(() => tfVarsFromRepoVars('{"TF_VAR_OK":"1","TF_VAR_bad-name":"2"}')).toThrow(
      TfVarsError,
    );
  });

  test('AC-4: TF_VAR_A together with tf_var_a throws and the message names both', () => {
    const message = failureOf(() => tfVarsFromRepoVars('{"TF_VAR_A":"1","tf_var_a":"2"}'));
    expect(message).toContain('TF_VAR_A');
    expect(message).toContain('tf_var_a');
  });
});

describe('AC-5: values with line breaks or NUL', () => {
  const secret = 'sentinel-secret-value';

  test.each([
    ['a line feed', `${secret}\nTF_VAR_other=injected`],
    ['a carriage return', `${secret}\rTF_VAR_other=injected`],
    ['a NUL', `${secret}\0more`],
  ])(
    'AC-5: a value with %s throws; the message names the key, never the value',
    (_label, value) => {
      const message = failureOf(() => tfVarsFromRepoVars(JSON.stringify({ TF_VAR_X: value })));
      expect(message).toContain('TF_VAR_X');
      expect(message).not.toContain(secret);
      expect(message).not.toContain('injected');
    },
  );

  test('AC-5: a value that is only a line feed throws too', () => {
    expect(() => tfVarsFromRepoVars('{"TF_VAR_X":"\\n"}')).toThrow(TfVarsError);
  });
});
