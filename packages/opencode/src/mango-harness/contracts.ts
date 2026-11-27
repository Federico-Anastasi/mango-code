// What the commands of the harness need from outside: the web, a browser, the user. The commands hold the rules
// (what is refused, what the model reads); these hold the world, so a test can give a fixed one.

/** A picture the model is shown: a PNG, base64-encoded. */
export type Picture = { mime: "image/png"; base64: string }

/** What a command answers: the text the model reads, the pictures it is shown with it, and whether the call failed or
 *  was refused. */
export type Answer = { text: string; failed: boolean; images?: Picture[] }

export type Found = { title: string; url: string; date?: string; text: string }
export type Opened = { title: string; date?: string; text: string }

export type Web = {
  /** The results for a query, best first; `days` keeps the ones of the last days. An Error: no network. */
  search(query: string, days?: number): Promise<Found[] | Error>
  /** The readable text of a page, with the addresses of its links. An Error says why it could not be had. */
  open(url: string): Promise<Opened | Error>
}

/** A piece of a page, in the order a reader meets it: a text, or something to click or fill. */
export type Item = { text: string } | { control: "link" | "button" | "field"; label: string }
/** A page as a model that sees no images reads it. `errors` are the errors of its console. For a page of a site, not a
 *  file of the project: `address`, where the page is now (a click may have moved it); `status`, what the site answered
 *  when it was opened (404: it has no page at that address). */
export type Page = {
  title: string
  items: Item[]
  errors: string[]
  address?: string
  status?: number
  /** The page holds what its text cannot carry: a canvas, a drawing, a picture with no description. */
  unseen?: true
}

export type Browser = {
  /** Opens a page: an http address, or the whole path of a file. It becomes the page `act` works on. */
  view(target: string): Promise<Page | Error>
  /** Acts on the open page and gives it as it is afterwards. `on` counts the controls of the page from 1, in
   *  the order of `items`; `text` is what to type, or the key to press. */
  act(action: "click" | "type" | "press", on?: number, text?: string): Promise<Page | Error>
  /** Goes back to the page before, as the back button of a browser does. */
  back(): Promise<Page | Error>
  /** A picture of what the open page shows now. */
  look?(): Promise<Picture | Error>
  /** Stops what the browser started. */
  close(): Promise<void>
}

/** A skill of the user's own: listed with those of the harness, opened with the same command. */
export type Skill = { name: string; description: string; body: string }

/** Asks the user a question, with the answers to choose from if there are any, and gives what they answered.
 *  `harness`: the harness asks, not the model (before a command that would lose files of the user's). */
export type User = (question: string, options: string[], by?: "harness") => Promise<string>
