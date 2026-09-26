import Link from 'next/link';
import { ProductCard } from '../components/ProductCard';
import { products } from '../lib/products';

export default function Home() {
  return (
    <main>
      <h1>Storefront</h1>
      <ul>
        {products.map((product) => (
          <li key={product.id}>
            <Link href={`/products/${product.id}`}>
              <ProductCard product={product} />
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
