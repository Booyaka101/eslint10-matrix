import { notFound } from 'next/navigation';
import { products } from '../../../lib/products';

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const product = products.find((p) => p.id === id);
  if (!product) notFound();
  return (
    <article>
      <h1>{product.name}</h1>
      <p>{product.description}</p>
    </article>
  );
}
