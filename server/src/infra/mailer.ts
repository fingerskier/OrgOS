export interface Mailer {
  sendMagicLink(to: string, link: string): Promise<void>
}

/** Dev mailer: logs the link and remembers the last one (for tests / dev UI). */
export class ConsoleMailer implements Mailer {
  last: { to: string; link: string } | null = null
  async sendMagicLink(to: string, link: string): Promise<void> {
    this.last = { to, link }
    console.log(`\n[magic-link] to=${to}\n  ${link}\n`)
  }
}
