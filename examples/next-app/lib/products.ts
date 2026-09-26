export interface Product {
  id: string;
  name: string;
  description: string;
  price: string;
  image: string;
}

export const products: Product[] = [
  { id: 'kettle', name: 'Kettle', description: 'Boils water.', price: '$39', image: '/kettle.png' },
  { id: 'mug', name: 'Mug', description: 'Holds what the kettle boiled.', price: '$12', image: '/mug.png' },
];
