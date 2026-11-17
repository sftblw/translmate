export const articlePageHtml = `<!doctype html>
<html>
  <head>
    <title>Article Fixture</title>
  </head>
  <body>
    <header>
      <nav>
        <a href="/home">Home</a>
        <a href="/pricing">Pricing</a>
      </nav>
    </header>
    <main>
      <article>
        <h1>How translation tools should handle web pages</h1>
        <p>Translation tools need to understand the main content before they ask a model to rewrite it.</p>
        <p>When a sentence contains <a href="/links">a useful link</a>, the surrounding words still belong to the same translation unit.</p>
      </article>
    </main>
    <footer>Contact and legal links</footer>
  </body>
</html>`;

export const richTextArticlePageHtml = `<!doctype html>
<html>
  <body>
    <div aria-label="Timeline: Conversation">
      <article role="article" data-testid="tweet">
        <div data-testid="User-Name">Addy Osmani @addyosmani</div>
        <div>
          <div>Loop Engineering.</div>
          <div role="group">
            <button data-testid="reply">286</button>
            <button data-testid="retweet">1.2K</button>
          </div>
          <div>
            <div
              class="public-DraftEditor-content"
              contenteditable="false"
            >
              <div data-contents="true">
                <div class="longform-unstyled" data-block="true">
                  <div class="public-DraftStyleDefault-block">
                    <span>Loop engineering is replacing yourself as the person who prompts the agent.</span>
                  </div>
                </div>
                <div class="longform-unstyled" data-block="true">
                  <div class="public-DraftStyleDefault-block">
                    <span>You design the system that does it instead.</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </article>
      <div data-testid="inline_reply_offscreen">
        <div contenteditable="true" data-testid="tweetTextarea_0" role="textbox">Reply draft should not translate</div>
      </div>
    </div>
  </body>
</html>`;

export const misleadingArticleCardPageHtml = `<!doctype html>
<html>
  <body>
    <main>
      <section>
        <div class="model-card-content prose">
          <h2>Model Introduction</h2>
          <p>The actual model card contains a substantial explanation that should be selected as the main translatable content.</p>
          <p>Its technical details continue across multiple paragraphs in this prose container.</p>
        </div>
      </section>
      <section>
        <article class="overview-card-wrapper">
          <a href="/collections/example">
            <header><h4>Small related collection card</h4></header>
          </a>
        </article>
      </section>
    </main>
  </body>
</html>`;
