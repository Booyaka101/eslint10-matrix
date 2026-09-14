<script>
  let { items = [], onOpen } = $props();

  let query = $state('');
  let open = $state(false);

  let matches = $derived(items.filter((item) => item.title.toLowerCase().includes(query.toLowerCase())));

  function submit(event) {
    event.preventDefault();
    onOpen?.(matches[0]?.id);
  }
</script>

<form role="search" onsubmit={submit}>
  <label for="catalogue-search">Search the catalogue</label>
  <input id="catalogue-search" type="search" bind:value={query} />
  <button type="submit">Go</button>
</form>

<button type="button" aria-expanded={open} aria-controls="results" onclick={() => (open = !open)}>
  {matches.length} results
</button>

<ul id="results" hidden={!open}>
  {#each matches as item (item.id)}
    <li>
      <a href={item.href}>{item.title}</a>
      <img src={item.thumbnail} alt={item.altText} width="320" height="180" />
    </li>
  {:else}
    <li>Nothing matched {query}</li>
  {/each}
</ul>

<div class="overlay" onclick={() => onOpen(items[0]?.id)}></div>
<marquee>Featured</marquee>
<a href="#">click here</a>
<img src="/banner.png" />
<input type="text" aria-label="" tabindex="4" />

<style>
  .overlay {
    position: absolute;
    inset: 0;
  }
</style>
