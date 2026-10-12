import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mailDir } from '../paths';

interface StoredMail {
  to: string;
  text?: string;
  html?: string;
}

/**
 * The newest sign-in link mailed to `address` (the file mailer names files by send time). The
 * server answers a request for a link before it writes the mail, so a test whose address has
 * signed in before passes `since`, the time just before its own request: mail older than that,
 * with a link that was used already, is then not taken while the new mail is on its way.
 */
export async function latestSignInLink(address: string, since = 0): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const names = (await readdir(mailDir).catch(() => [] as string[]))
      .filter((n) => n.endsWith('.json') && Number.parseInt(n, 10) >= since)
      .sort()
      .reverse();
    for (const name of names) {
      const mail = JSON.parse(await readFile(join(mailDir, name), 'utf8')) as StoredMail;
      if (mail.to.toLowerCase() !== address.toLowerCase()) continue;
      const link = /https?:\/\/[^\s"'<>]+\/api\/auth\/verify\?token=[^\s"'<>]+/.exec(
        `${mail.text ?? ''} ${mail.html ?? ''}`,
      );
      if (link) return link[0];
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no sign-in mail for ${address}`);
}
