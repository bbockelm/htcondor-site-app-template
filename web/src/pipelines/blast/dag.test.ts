import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDagFile, buildNodeFiles, planNodes, nodeSubmitName } from './dag';
import {
  BLAST_IMAGE,
  CONTAINER_SLOTS,
  EXIT_NO_BLAST,
  RUNNER_FILE,
  buildRunnerScript,
  missingToolAdvice,
  type JobSpec,
} from './blast';
import { blast } from './index';
import { api } from '../../lib/api';

const base: Omit<JobSpec, 'queryNames' | 'queryBytes' | 'node'> = {
  program: 'blastn',
  evalue: '1e-5',
  maxHits: 25,
  databaseLabel: 'nt.fasta.gz',
  databaseKind: 'fasta-gz',
  databaseFile: 'database.fasta.gz',
  databaseBytes: 100 * 1024 * 1024,
};

/**
 * A File of a stated size. The planner only reads `.size`, and
 * building a real multi-megabyte File per test would make these slow
 * for no added confidence.
 */
function sized(name: string, size: number): File {
  const f = new File([new Uint8Array(1)], name, { type: 'text/plain' });
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

describe('planNodes', () => {
  it('puts each query on its own node by default', () => {
    const nodes = planNodes(['a.fa', 'b.fa', 'c.fa'], [1, 2, 3], base, 1);
    expect(nodes).toHaveLength(3);
    expect(nodes.map((n) => n.spec.queryNames)).toEqual([['a.fa'], ['b.fa'], ['c.fa']]);
  });

  it('groups when asked, and carries the bytes for the disk estimate', () => {
    const nodes = planNodes(['a.fa', 'b.fa', 'c.fa'], [10, 20, 30], base, 2);
    expect(nodes).toHaveLength(2);
    expect(nodes[0].spec.queryBytes).toBe(30);
    expect(nodes[1].spec.queryBytes).toBe(30);
  });

  it('gives every node a distinct submit file name', () => {
    const nodes = planNodes(['a.fa', 'b.fa', 'c.fa'], [1, 1, 1], base, 1);
    const names = new Set(nodes.map((n) => n.submitName));
    // The spool is one flat directory: two nodes sharing a submit file
    // name would be one node silently running twice.
    expect(names.size).toBe(nodes.length);
    expect(nodes[1].submitName).toBe(nodeSubmitName(1));
  });
});

describe('the DAG file', () => {
  it('names every node job', () => {
    const nodes = planNodes(['a.fa', 'b.fa'], [1, 1], base, 1);
    const dag = buildDagFile(nodes);
    for (const n of nodes) {
      expect(dag).toContain(`JOB ${n.name} ${n.submitName}`);
    }
  });

  it('writes no edges, because there are none', () => {
    const dag = buildDagFile(planNodes(['a.fa', 'b.fa'], [1, 1], base, 1));
    // Edges that do not exist would claim an ordering the science does
    // not have, and DAGMan would honour it.
    expect(dag).not.toMatch(/^PARENT /m);
  });

  it('does not name the database: it is already in the spool', () => {
    const dag = buildDagFile(planNodes(['a.fa'], [1], base, 1));
    expect(dag).not.toContain('database.fasta.gz\nJOB');
    expect(dag).not.toMatch(/^JOB .*database/m);
  });
});

describe('node submit files', () => {
  it('declares the database by basename, so the spool copy is used', () => {
    const nodes = planNodes(['a.fa'], [1], base, 1);
    const files = buildNodeFiles(nodes);
    const sub = files[nodes[0].submitName];
    expect(sub).toContain('transfer_input_files');
    expect(sub).toContain(base.databaseFile);
    // No path: the spool is flat and DAGMan runs in it.
    expect(sub).not.toContain('/database');
  });

  it('sets no batch name per node', () => {
    // The name belongs on the manager job; per-node it would name the
    // parts rather than the search. And `JobBatchName =` in a submit
    // file sets a macro, not the attribute.
    const nodes = planNodes(['a.fa'], [1], base, 1);
    const sub = buildNodeFiles(nodes)[nodes[0].submitName];
    expect(sub).not.toContain('JobBatchName');
    expect(sub).not.toContain('batch_name');
  });
});

/**
 * The database and the queries are separate slots now.
 *
 * Async because planning asks the pool whether it can run a container
 * before it writes a submit file -- see chooseImage. Every test below
 * says which answer it is planning against, because the two produce
 * different submit files and a test that did not say would be pinning
 * whichever one the stub happened to give.
 */
function plan(database: File | null, queries: File[], options = blast.defaults) {
  return blast.plan({ database: database ? [database] : [], queries }, options);
}

/** The pool answers `has`: true, false, or null for "cannot tell". */
function poolAnswers(has: boolean | null) {
  vi.spyOn(api, 'poolHas').mockResolvedValue(has);
}

describe('the plan the shell submits', () => {
  // Not the real collector: these tests are about what is planned, and
  // the probe has its own tests below.
  beforeEach(() => poolAnswers(true));
  const db = sized('nt.fasta.gz', 50 * 1024 * 1024);
  const q1 = sized('reads1.fa', 1024);
  const q2 = sized('reads2.fa', 2048);

  it('uploads the database exactly once', async () => {
    const planned = await plan(db, [q1, q2]);
    if (planned.kind !== 'dag') throw new Error(`want a dag, got ${planned.kind}`);
    // The whole reason this pipeline is a DAG. If this ever counts two,
    // the user is pushing the database per job again.
    const dbUploads = planned.uploads.filter((u) => u.file === db);
    expect(dbUploads).toHaveLength(1);
    expect(planned.uploads).toHaveLength(3);
  });

  it('carries the runner and one submit file per query', async () => {
    const planned = await plan(db, [q1, q2]);
    if (planned.kind !== 'dag') throw new Error('want a dag');
    expect(planned.nodeFiles[RUNNER_FILE]).toContain('#!/bin/bash');
    expect(Object.keys(planned.nodeFiles).filter((n) => n.endsWith('.sub'))).toHaveLength(2);
  });

  it('refuses two queries with the same name', async () => {
    // One flat directory. Two files called reads.fa are one file, and
    // one node would silently search the other's sequences.
    const a = sized('reads.fa', 10);
    const b = sized('reads.fa', 20);
    const planned = await plan(db, [a, b]);
    expect(planned.kind).toBe('error');
    if (planned.kind === 'error') expect(planned.message).toContain('reads.fa');
  });

  it('refuses a query name that is not safe to transfer', async () => {
    const planned = await plan(db, [sized('$(evil).fa', 10)]);
    expect(planned.kind).toBe('error');
  });

  it('asks for a database when there is none, by name', async () => {
    const planned = await plan(null, [q1]);
    expect(planned.kind).toBe('error');
    if (planned.kind === 'error') expect(planned.message).toContain('database');
  });

  it('asks for queries when there are none, by name', async () => {
    const planned = await plan(db, []);
    expect(planned.kind).toBe('error');
    if (planned.kind === 'error') expect(planned.message).toContain('query');
  });
});


describe('retries', () => {
  it('retries a node, but not the one failure that cannot succeed', () => {
    // "No BLAST+ on the pool" returns the same answer however many
    // times it is asked. Retrying it turns a twenty-second answer into
    // a several-minute one, and the user watches the whole wait.
    const dag = buildDagFile(planNodes(['a.fa'], [1], base, 1));
    expect(dag).toMatch(/^RETRY q0 2 UNLESS-EXIT 70$/m);
  });

  it('uses the same code the runner actually exits with', () => {
    // The DAG line and the runner have to agree. If they drift, the
    // UNLESS-EXIT excuses nothing and nobody notices except as a slow
    // failure.
    const nodes = planNodes(['a.fa'], [1], base, 1);
    expect(buildDagFile(nodes)).toContain(`UNLESS-EXIT ${EXIT_NO_BLAST}`);
    // The runner exits with that code when the tool is missing.
    const runner = buildRunnerScript(nodes[0].spec);
    expect(runner).toMatch(
      new RegExp(`does not have \\$1 installed[^\n]*" ${EXIT_NO_BLAST}$`, 'm'),
    );
  });
});

describe('where BLAST comes from', () => {
  const db = sized('nt.fasta.gz', 50 * 1024 * 1024);
  const q1 = sized('reads1.fa', 1024);

  /** The one node's submit file, planned against a given pool. */
  async function submitFile(has: boolean | null): Promise<string> {
    poolAnswers(has);
    const planned = await plan(db, [q1]);
    if (planned.kind !== 'dag') throw new Error(`want a dag, got ${planned.kind}`);
    const sub = Object.keys(planned.nodeFiles).find((n) => n.endsWith('.sub'))!;
    return planned.nodeFiles[sub];
  }

  it('runs in a container, because a pool with BLAST+ installed is the rare one', async () => {
    // The reported failure: the example "doesn't work" at a site whose
    // execute nodes have no BLAST+. Every search returned the runner's
    // "ask your administrator" message, which is a correct message and
    // a useless example.
    const sub = await submitFile(true);
    expect(sub).toContain('universe = container');
    expect(sub).toContain(`container_image = ${BLAST_IMAGE}`);
  });

  it('asks the pool, not a settings page', async () => {
    const spy = vi.spyOn(api, 'poolHas').mockResolvedValue(true);
    await plan(db, [q1]);
    expect(spy).toHaveBeenCalledWith(CONTAINER_SLOTS);
    // The SAME attributes condor_submit puts in the job's own
    // requirements for a docker:// image, read off a dry run:
    //
    //   Requirements = ... && TARGET.HasContainer && TARGET.HasDockerURL && ...
    //
    // If these two ever drift apart, the app plans a container job for
    // a pool that will never match it -- which looks, to the user,
    // exactly like the stall this example already caused once.
    expect(CONTAINER_SLOTS).toContain('HasContainer');
    expect(CONTAINER_SLOTS).toContain('HasDockerURL');
    // And not the guess that reads right and is wrong: an Apptainer
    // site publishes HasSingularity, never HasApptainer.
    expect(CONTAINER_SLOTS).not.toContain('HasApptainer');
  });

  it('falls back to the installed BLAST+ where the pool cannot run one', async () => {
    // The demo pool is exactly this: one slot, no container runtime.
    // If this ever stops working, the example stops working in the
    // place it is most often seen first.
    const sub = await submitFile(false);
    expect(sub).toContain('universe = vanilla');
    expect(sub).not.toContain('container_image');
  });

  it('prefers the container when the pool will not say', async () => {
    // A guess that lands on the container gives a job that does not
    // match, and says so. A guess that lands on bare BLAST+ gives a
    // job that runs and fails. Those are not equally bad.
    const sub = await submitFile(null);
    expect(sub).toContain('universe = container');
  });

  it('keeps the executable out of the transfer either way', async () => {
    // In container universe /usr/bin/env is a path inside the image;
    // in vanilla it is the execute node's. Neither is ours to send,
    // and transferring it would send the access point's binary to run
    // against the image's libraries.
    for (const has of [true, false]) {
      expect(await submitFile(has)).toContain('transfer_executable = false');
    }
  });
});

describe('what the runner says when it cannot find BLAST', () => {
  const spec: JobSpec = {
    ...base,
    node: 'q0',
    queryNames: ['a.fa'],
    queryBytes: 10,
  };

  it('names the image, when the image was supposed to bring it', () => {
    // Nothing the reader does to their pool fixes a tool missing from
    // an image, so the advice must not send them to an administrator.
    const script = buildRunnerScript({ ...spec, image: BLAST_IMAGE });
    expect(script).toContain(BLAST_IMAGE);
    expect(script).not.toContain('Ask your system administrator');
  });

  it('sends them to an administrator, when the pool was supposed to have it', () => {
    const script = buildRunnerScript(spec);
    expect(script).toContain('Ask your system administrator');
    // And says why the job could not simply bring its own, which is
    // the question anyone who has used containers will ask.
    expect(script).toContain('cannot run containers');
  });

  it('keeps the shell variable, so the message names the tool it looked for', () => {
    // The advice is interpolated into a shell string by the generator;
    // `$1` has to survive that as `$1` and be expanded by the shell.
    expect(missingToolAdvice(spec)).toContain('$1');
    expect(buildRunnerScript(spec)).toMatch(/finish error ".*\$1.*"/);
  });
});
