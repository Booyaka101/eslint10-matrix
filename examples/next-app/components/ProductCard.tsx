import Image from 'next/image';
import type { Product } from '../lib/products';

export function ProductCard({ product }: { product: Product }) {
  return (
    <figure>
      <Image src={product.image} alt={product.name} width={320} height={240} />
      <figcaption>
        {product.name} <span>{product.price}</span>
      </figcaption>
    </figure>
  );
}
