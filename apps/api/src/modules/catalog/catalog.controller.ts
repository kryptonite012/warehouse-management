import {
  BadRequestException, Body, Controller, Get, Header, Param, ParseUUIDPipe, Patch, Post, Query, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthContext } from '../../common/auth-context';
import { CurrentActor, RequirePermissions } from '../../common/decorators';
import { PERMISSIONS as P } from '../../common/permissions';
import { StorageService } from '../../common/storage.service';
import { AddBarcodeDto, CreateCategoryDto, CreateProductDto, ProductListQuery, UpdateProductDto, UpdateSkuPriceDto } from './catalog.dto';
import { CatalogService } from './catalog.service';

class ImportDto {
  @IsString() @MaxLength(5_000_000) csv: string;
  @IsOptional() @IsBoolean() dryRun?: boolean;
}

const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

@ApiTags('products')
@ApiBearerAuth()
@Controller()
export class CatalogController {
  constructor(private readonly svc: CatalogService, private readonly storage: StorageService) {}

  @Get('products') @RequirePermissions(P.PRODUCTS_READ)
  list(@CurrentActor() a: AuthContext, @Query() q: ProductListQuery) {
    return this.svc.list(a, q);
  }

  @Post('products') @RequirePermissions(P.PRODUCTS_MANAGE)
  create(@CurrentActor() a: AuthContext, @Body() dto: CreateProductDto) {
    return this.svc.create(a, dto);
  }

  @Get('products/export.csv') @RequirePermissions(P.PRODUCTS_READ)
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="products.csv"')
  export(@CurrentActor() a: AuthContext) {
    return this.svc.exportCsv(a);
  }

  @Post('products/import') @RequirePermissions(P.PRODUCTS_MANAGE)
  import(@CurrentActor() a: AuthContext, @Body() dto: ImportDto) {
    return this.svc.importCsv(a, dto.csv, dto.dryRun ?? false);
  }

  @Get('products/:id') @RequirePermissions(P.PRODUCTS_READ)
  get(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.get(a, id);
  }

  @Patch('products/:id') @RequirePermissions(P.PRODUCTS_MANAGE)
  update(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProductDto) {
    return this.svc.update(a, id, dto);
  }

  @Get('products/:id/barcodes') @RequirePermissions(P.PRODUCTS_READ)
  barcodes(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.barcodes(a, id);
  }

  @Post('products/:id/images') @RequirePermissions(P.PRODUCTS_MANAGE)
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  async upload(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('file is required');
    const ext = IMAGE_TYPES[file.mimetype];
    if (!ext) throw new BadRequestException('Only JPEG, PNG or WebP images are accepted');
    await this.svc.get(a, id);
    const stored = await this.storage.put(`products/${id}`, file.buffer, file.mimetype, ext);
    return this.svc.addImage(a, id, stored.key, stored.url);
  }

  @Patch('skus/:id/pricing') @RequirePermissions(P.PRODUCTS_MANAGE)
  pricing(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSkuPriceDto) {
    return this.svc.updateSkuPricing(a, id, dto);
  }

  @Post('skus/:id/barcodes') @RequirePermissions(P.PRODUCTS_MANAGE)
  addBarcode(@CurrentActor() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddBarcodeDto) {
    return this.svc.addBarcode(a, id, dto);
  }

  @Get('barcodes/:code') @RequirePermissions(P.PRODUCTS_READ)
  resolve(@CurrentActor() a: AuthContext, @Param('code') code: string) {
    return this.svc.resolveBarcode(a, code);
  }

  @Get('categories') @RequirePermissions(P.PRODUCTS_READ)
  categories(@CurrentActor() a: AuthContext) {
    return this.svc.categories(a);
  }

  @Post('categories') @RequirePermissions(P.PRODUCTS_MANAGE)
  createCategory(@CurrentActor() a: AuthContext, @Body() dto: CreateCategoryDto) {
    return this.svc.createCategory(a, dto);
  }

  @Get('tax-categories') @RequirePermissions(P.PRODUCTS_READ)
  taxes(@CurrentActor() a: AuthContext) {
    return this.svc.taxCategories(a);
  }
}
